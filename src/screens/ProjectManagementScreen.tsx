/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {
    useState,
    useEffect,
    useMemo,
    useCallback,
    useRef,
} from "react";
import { motion } from "motion/react";
import {
    ArrowLeft,
    Table as TableIcon,
    Menu,
    ChevronRight,
    ChevronLeft,
    Trash2,
    Package,
    Boxes,
    Loader2,
    Upload,
    Pencil,
    X,
    Save,
    Plus,
    CheckCircle,
    XCircle,
    Users,
    Eye,
    EyeOff,
    FileSearch,
    Download,
    Layers,
    Maximize,
    Minimize,
    Check,
    CreditCard,
    CheckSquare,
    ClipboardCheck,
    GripVertical,
    ArrowUpDown,
    GitMerge,
    Link2,
    FileEdit,
    Cuboid,
    Info,
    History,
    MoreVertical,
    Image as ImageIcon,
    Clock,
    Code,
} from "lucide-react";
import {
    doc,
    getDoc,
    deleteDoc,
    writeBatch,
    query,
    collection,
    where,
    getDocs,
    addDoc,
    serverTimestamp,
    updateDoc,
    onSnapshot,
} from "firebase/firestore";
import { useAuth } from "../lib/AuthContext";
import { useLanguage } from "../lib/LanguageContext";
import { db, handleFirestoreError, OperationType, onCustomersSnapshot } from "../lib/firebase";
import {
    deleteProjectModule,
    batchUpdateProjectModules,
    batchDeleteProjectModules,
    batchUpdateProjectModulesByConfig,
    deleteProjectConfigAndModules,
    findProjectConfigId,
    markProjectCompleted,
} from "../lib/dualWrite";
import {
    ProjectEntry,
    StockItem,
    ManagementScreenProps,
    getModuleQcAggregate,
    getModuleInstances,
} from "../types";
import { formatProjectCode, formatProjectName, getProjectGroupColor } from "../lib/formatters";

// Import sub-components
import { DrawingViewerModal } from "../components/project/DrawingViewerModal";
import { DrawingEditorModal } from "../components/project/DrawingEditorModal";
import { NativeModelViewerModal } from "../components/project/NativeModelViewerModal";
import { NativeModelEditorModal } from "../components/project/NativeModelEditorModal";
import { DeleteConfirmationModal } from "../components/project/DeleteConfirmationModal";
import { StatusUpdateModal } from "../components/project/StatusUpdateModal";
import { ModuleDetailModal } from "../components/project/ModuleDetailModal";
import { AccessoryUpdateModal } from "../components/project/AccessoryUpdateModal";
import { AddProjectAccessoryModal } from "../components/project/AddProjectAccessoryModal";
import { EditProjectScreen } from "../components/project/EditProjectScreen";
import { ExportProposalModal } from "../components/project/ExportProposalModal";
import { BulkDeleteConfirmationModal } from "../components/project/BulkDeleteConfirmationModal";
import { TempLabelsModal } from "../components/project/TempLabelsModal";
import { ExcelEditorModal } from "../components/project/ExcelEditorModal";
import { ReceivedStatusModal } from "../components/project/ReceivedStatusModal";
import { QuickMergeModal } from "../components/project/QuickMergeModal";
import { EditProjectInfoModal } from "../components/project/EditProjectInfoModal";
import { AllPhotosByClusterModal } from "../components/project/AllPhotosByClusterModal";
import { ModuleThreeViewer } from "../components/project/ModuleThreeViewer";
import { ModuleCustomNamesModal } from "../components/project/ModuleCustomNamesModal";
import { useGLTF } from "@react-three/drei";

export const getEntryTypeClassification = (
    entry: any,
):
    | "Thùng"
    | "Cánh"
    | "Đợt"
    | "Đợt di động"
    | "Mặt HK"
    | "CTHT"
    | "Len, Filler" => {
    const code = entry.moduleCode || "";
    const name = entry.moduleName || entry.name || "";
    const codeLower = code.toLowerCase();
    const nameLower = name.toLowerCase();

    if (
        codeLower.includes("len") ||
        codeLower.includes("filler") ||
        codeLower.includes("fillter") ||
        codeLower.includes("thanh treo") ||
        codeLower.includes("thanh_treo") ||
        nameLower.includes("len") ||
        nameLower.includes("filler") ||
        nameLower.includes("fillter") ||
        nameLower.includes("thanh treo")
    ) {
        return "Len, Filler";
    }

    // Kiểm tra nếu gốc là "Thùng" (nếu cũ không phải Cánh/Mặt HK và không phải CTHT)
    const isOriginalCanhMatHK =
        codeLower.includes("mặt học kéo") ||
        codeLower.includes("mat hoc keo") ||
        codeLower.includes("cửa") ||
        codeLower.includes("cua");
    const isOriginalCTHT =
        codeLower.includes("tấm hoàn thiện") ||
        codeLower.includes("tam hoan thien") ||
        codeLower.includes("hoàn thiện") ||
        codeLower.includes("hoan thien") ||
        codeLower.includes("ctht") ||
        code.split("_").length >= 3;

    if (!isOriginalCanhMatHK && !isOriginalCTHT) {
        return "Thùng";
    }

    // 1. Module nào có "Cánh" hoặc "Cửa" trong tên -> "Cánh"
    if (
        codeLower.includes("cánh") ||
        codeLower.includes("canh") ||
        codeLower.includes("cửa") ||
        codeLower.includes("cua")
    ) {
        return "Cánh";
    }

    // 2. có "Đợt" trong tên -> "Đợt di động"
    if (codeLower.includes("đợt") || codeLower.includes("dot")) {
        return "Đợt di động";
    }

    // 3. có "Mặt" trong tên -> "Mặt HK"
    if (codeLower.includes("mặt") || codeLower.includes("mat")) {
        return "Mặt HK";
    }

    // 4. còn lại -> "CTHT"
    return "CTHT";
};

export const getEntryType = (
    entry: any,
):
    | "Thùng"
    | "Cánh"
    | "Đợt"
    | "Đợt di động"
    | "Mặt HK"
    | "CTHT"
    | "Gia công ngoài"
    | "Gia Công Ngoài"
    | "Len, Filler" => {
    const code = entry.moduleCode || "";
    const name = entry.moduleName || entry.name || "";
    const codeLower = code.toLowerCase();
    const nameLower = name.toLowerCase();

    if (
        codeLower.includes("len") ||
        codeLower.includes("filler") ||
        codeLower.includes("fillter") ||
        codeLower.includes("thanh treo") ||
        codeLower.includes("thanh_treo") ||
        nameLower.includes("len") ||
        nameLower.includes("filler") ||
        nameLower.includes("fillter") ||
        nameLower.includes("thanh treo")
    ) {
        return "Len, Filler";
    }

    if (entry.classification) {
        if (
            entry.classification === "Gia Công Ngoài" ||
            entry.classification === "Gia công ngoài"
        ) {
            return "Gia công ngoài";
        }
        if (entry.classification === "Len, Filler") {
            return "Len, Filler";
        }
        return entry.classification;
    }
    return getEntryTypeClassification(entry);
};

export function getParentCodeCandidate(moduleCode: string): string {
    const parts = moduleCode.split("_");
    if (parts.length < 3) return moduleCode;

    const filteredParts = parts.filter((part) => {
        const pLower = part.toLowerCase();
        const isDescriptor =
            pLower.includes("cửa") ||
            pLower.includes("cua") ||
            pLower.includes("mặt học kéo") ||
            pLower.includes("mat hoc keo") ||
            pLower.includes("tấm hoàn thiện") ||
            pLower.includes("tam hoan thien") ||
            pLower.includes("hoàn thiện") ||
            pLower.includes("hoan thien") ||
            pLower.includes("hông") ||
            pLower.includes("hong") ||
            pLower.includes("nóc") ||
            pLower.includes("noc") ||
            pLower.includes("đáy") ||
            pLower.includes("day");
        return !isDescriptor;
    });

    if (filteredParts.length >= 2 && filteredParts.length < parts.length) {
        return filteredParts.join("_");
    }

    return `${parts[0]}_${parts[parts.length - 1]}`;
}

export function buildAndSortTree(filteredList: ProjectEntry[]) {
    const result: (ProjectEntry & { parentId?: string; isChild?: boolean })[] =
        [];

    const allEntriesMap = new Map<string, ProjectEntry>();
    filteredList.forEach((e) => {
        allEntriesMap.set(e.id, e);
    });

    const parents = filteredList.filter((e) => {
        if (e.parentId) return false;
        return getEntryType(e) === "Thùng";
    });

    const parentCodeMap = new Map<string, ProjectEntry>();
    parents.forEach((p) => {
        if (p.moduleCode) parentCodeMap.set(p.moduleCode.toLowerCase(), p);
    });

    const childrenMap = new Map<string, ProjectEntry[]>(); // keyed by parent ID
    const independents: ProjectEntry[] = [];

    filteredList.forEach((e) => {
        if (getEntryType(e) === "Thùng" && !e.parentId) return;

        let parentObj: ProjectEntry | undefined;

        // 1. Check direct database parentId first
        if (e.parentId) {
            parentObj = allEntriesMap.get(e.parentId);
        }

        // 2. Check direct database parentModuleCode next
        if (!parentObj && e.parentModuleCode) {
            parentObj = parents.find(
                (p) =>
                    p.moduleCode &&
                    p.moduleCode.toLowerCase() ===
                        e.parentModuleCode!.toLowerCase(),
            );
        }

        if (parentObj) {
            const targetParentId = parentObj.id;
            if (!childrenMap.has(targetParentId)) {
                childrenMap.set(targetParentId, []);
            }
            childrenMap.get(targetParentId)!.push(e);
        } else {
            independents.push(e);
        }
    });

    // Lấy danh sách các cụm (cluster) có mặt theo thứ tự xuất hiện ban đầu
    const clusterOrder: string[] = [];
    filteredList.forEach((e) => {
        const c = e.cluster || "";
        if (!clusterOrder.includes(c)) {
            clusterOrder.push(c);
        }
    });

    // Nhóm theo Cụm
    clusterOrder.forEach((currentCluster) => {
        // Lấy các Thùng thuộc cụm này
        const clusterParents = parents.filter(
            (p) => (p.cluster || "") === currentCluster,
        );

        clusterParents.forEach((p) => {
            result.push(p);
            const children = childrenMap.get(p.id) || [];
            // Sắp xếp các con thực sự của Thùng: Đợt -> Cánh -> Mặt HK -> CTHT
            const sortedChildren = [...children].sort((a, b) => {
                const typeA = getEntryType(a);
                const typeB = getEntryType(b);

                const order: Record<string, number> = {
                    Đợt: 1,
                    Cánh: 2,
                    "Mặt HK": 3,
                    CTHT: 4,
                    Thùng: 5,
                };
                const valA = order[typeA] || 99;
                const valB = order[typeB] || 99;

                return valA - valB;
            });

            sortedChildren.forEach((c) => {
                result.push({
                    ...c,
                    parentId: p.id,
                    isChild: true,
                });
            });
        });

        // Lấy các phần tử độc lập thuộc cụm này (không có cha Thùng phù hợp từ Code)
        const clusterIndependents = independents.filter(
            (i) => (i.cluster || "") === currentCluster,
        );
        // Sắp xếp các phần tử độc lập: Đợt -> Cánh -> Mặt HK -> CTHT
        const sortedIndependents = [...clusterIndependents].sort((a, b) => {
            const typeA = getEntryType(a);
            const typeB = getEntryType(b);

            const order: Record<string, number> = {
                Đợt: 1,
                Cánh: 2,
                "Mặt HK": 3,
                CTHT: 4,
                Thùng: 5,
            };
            const valA = order[typeA] || 99;
            const valB = order[typeB] || 99;

            return valA - valB;
        });

        sortedIndependents.forEach((i) => {
            result.push({
                ...i,
                isChild: false, // Đứng độc lập ngang hàng với Thùng dưới danh sách của cụm
            });
        });
    });

    // Phòng hờ phần độc lập bị sót
    independents.forEach((i) => {
        if (!result.some((r) => r.id === i.id)) {
            result.push({
                ...i,
                isChild: false,
            });
        }
    });

    // Phòng hờ Thùng bị sót
    parents.forEach((p) => {
        if (!result.some((r) => r.id === p.id)) {
            result.push(p);
            const children = childrenMap.get(p.id) || [];
            children.forEach((c) => {
                result.push({
                    ...c,
                    parentId: p.id,
                    isChild: true,
                });
            });
        }
    });

    return result;
}

const makeShelfModuleCode = (parentCode: string): string => {
    if (!parentCode) return "";
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

export function ManagementScreen({
    items,
    projectEntries,
    setProjectEntries,
    selectedProject,
    setSelectedProject,
    loading,
    isSelectMode,
    setIsSelectMode,
    selectedModuleIds,
    setSelectedModuleIds,
    showBulkModal,
    setShowBulkModal,
    setHeaderContent,
    qcTickets = [],
}: ManagementScreenProps) {
    const { user, role, roles, userProfile, hasRole, isGuest } = useAuth();
    const { t } = useLanguage();
    const isAdmin = hasRole("admin");
    const canPrintLabel = isAdmin || hasRole("mod_x1") || hasRole("mod_x2");

    // Load customers for project group mapping
    const [customerProjectMap, setCustomerProjectMap] = useState<Record<string, string>>({});

    // --- localStorage cache cho customerProjectMap (dùng chung key với PackingScreen) ---
    const CUSTOMER_MAP_CACHE_KEY = 'draco_customer_project_map_cache';
    const CUSTOMER_MAP_TS_KEY = 'draco_customer_project_map_ts';
    const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

    // Load từ cache ngay lập tức
    useEffect(() => {
      try {
        const ts = Number(localStorage.getItem(CUSTOMER_MAP_TS_KEY) || 0);
        if (Date.now() - ts <= CACHE_MAX_AGE_MS) {
          const raw = localStorage.getItem(CUSTOMER_MAP_CACHE_KEY);
          if (raw) {
            const cached = JSON.parse(raw);
            if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
              setCustomerProjectMap(cached);
            }
          }
        }
      } catch {}
    }, []);

    // Real-time listener
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
            try {
              localStorage.setItem(CUSTOMER_MAP_CACHE_KEY, JSON.stringify(map));
              localStorage.setItem(CUSTOMER_MAP_TS_KEY, String(Date.now()));
            } catch {}
        });
        return () => unsub();
    }, []);

    const isModuleInTicket = (
        moduleId: string,
        moduleCode: string,
        stageId: string,
    ) => {
        return qcTickets.some(
            (t) =>
                t.stage === stageId &&
                t.status === "pending" &&
                (t.modules || []).some(
                    (m: any) =>
                        (m.id === moduleId || m.moduleCode === moduleCode) &&
                        m.status !== "pass" &&
                        m.status !== "fail",
                ),
        );
    };
    const canEdit = isAdmin;
    const isPrivileged = isAdmin;
    const canSendQC = hasRole("admin") || hasRole("mod_x1");
    const canUploadClusterPhotos = hasRole("admin") || hasRole("mod_qc");

    const [isSorting, setIsSorting] = useState(false);

    const handleAutoSort = async () => {
        if (isSorting || !selectedProject || rawEntries.length === 0) return;
        if (
            !window.confirm(
                t("Bạn có chắc chắn muốn sắp xếp lại tất cả các module con theo đúng module thùng cha?"),
            )
        ) {
            return;
        }
        setIsSorting(true);
        try {
            const sortedTree = buildAndSortTree(rawEntries);
            await batchUpdateProjectModules(
                sortedTree.map((item, idx) => ({
                    moduleId: item.id,
                    data: { sortIndex: idx },
                    projectCode: item.projectCode,
                })),
            );
            alert(t("Đã sắp xếp lại và lưu thứ tự thành công!"));
        } catch (err) {
            console.error("Lỗi khi sắp xếp:", err);
            handleFirestoreError(err, OperationType.UPDATE, "projects");
        } finally {
            setIsSorting(false);
        }
    };
    const [selectedModuleId, setSelectedModuleId] = useState<string | null>(
        null,
    );
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [completingProject, setCompletingProject] = useState(false);
    const [clusterFilter, setClusterFilter] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState<string | null>(null);
    const [moduleSearchQuery, setModuleSearchQuery] = useState('');
    const [typeFilter, setTypeFilter] = useState<"all" | "thung" | "other">(
        "all",
    );
    const [moduleTab, setModuleTab] = useState<
        "thung" | "ctht" | "lenFiller" | "phukien"
    >("thung");
    const [showChildren, setShowChildren] = useState<boolean>(!isGuest);
    const [selectedAccForUpdate, setSelectedAccForUpdate] = useState<{
        name: string;
        total: number;
        issued: number;
        status: string;
    } | null>(null);
    const [showAddAccModal, setShowAddAccModal] = useState(false);
    const [showExportProposalModal, setShowExportProposalModal] =
        useState(false);
    const [showDrawingViewer, setShowDrawingViewer] = useState<string | null>(
        null,
    );
    const [showDrawingEditor, setShowDrawingEditor] = useState(false);
    const [showNativeViewer, setShowNativeViewer] = useState<{
        url: string;
        drawingUrl: string;
        clusters: string[];
        entries: ProjectEntry[];
        viewMode?: "3d" | "pdf";
    } | null>(null);
    const [showNativeEditor, setShowNativeEditor] = useState(false);
    const [showEditProjectInfoModal, setShowEditProjectInfoModal] =
        useState(false);
    const [newDrawingUrl, setNewDrawingUrl] = useState("");
    const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
    const [showTempLabels, setShowTempLabels] = useState(false);
    const [showAllPhotosModal, setShowAllPhotosModal] = useState(false);
    const [showExcelEditorModal, setShowExcelEditorModal] = useState(false);
    const [showQuickMergeModal, setShowQuickMergeModal] = useState(false);
    const [showModuleMenu, setShowModuleMenu] = useState(false);
    const [lightboxImages, setLightboxImages] = useState<string[]>([]);
    const [lightboxStartIndex, setLightboxStartIndex] = useState(0);
    const moduleMenuRef = useRef<HTMLDivElement>(null);
    const [showReceivedStatusModal, setShowReceivedStatusModal] = useState<
        "received" | "unreceived" | null
    >(null);
    const [selectedModuleDetail, setSelectedModuleDetail] =
        useState<ProjectEntry | null>(null);
    const [showModuleRawData, setShowModuleRawData] = useState(false);
    const [showCustomNamesModal, setShowCustomNamesModal] = useState(false);
    const [detailPackingPhotos, setDetailPackingPhotos] = useState<
        { url: string; instanceIndex?: number }[]
    >([]);
    const [detailMatchLogs, setDetailMatchLogs] = useState<
        { name: string; state: 'clear' | 'faded' | 'hidden'; matchedKey?: string }[]
    >([]);
    useEffect(() => {
        if (!selectedModuleDetail) {
            setDetailPackingPhotos([]);
            setDetailMatchLogs([]);
            return;
        }
        const cleanCode = selectedModuleDetail.moduleCode
            .replace(/\s*#\d+\/\d+$/, "")
            .trim()
            .toLowerCase();
        const moduleId = selectedModuleDetail.id || '';
        const projectCode = selectedModuleDetail.projectCode || '';
        // Query packing theo projectCode để lấy đúng phiếu đóng gói của dự án
        const q = projectCode
            ? query(collection(db, "packing"), where("projectCode", "==", projectCode))
            : query(collection(db, "packing"));
        const unsub = onSnapshot(
            q,
            (snap) => {
                const photos: { url: string; instanceIndex?: number }[] = [];
                const seenUrls = new Set<string>();
                snap.docs.forEach((d) => {
                    const list = d.data() as any;
                    (list.items || []).forEach((item: any) => {
                        const itemName = (item.name || "").toLowerCase().trim();
                        const itemCode = itemName
                            .replace(/\s*#\d+\/\d+$/, "")
                            .trim();
                        const itemId = item.id || '';
                        const matchesByName =
                            itemCode === cleanCode;
                        const matchesById = moduleId && itemId.startsWith(moduleId);
                        if (matchesByName || matchesById) {
                            const instIdx = item.instanceIndex;
                            if (item.photos?.length) {
                                item.photos
                                    .filter(Boolean)
                                    .forEach((p: string) => {
                                        if (!seenUrls.has(p)) {
                                            seenUrls.add(p);
                                            photos.push({
                                                url: p,
                                                instanceIndex: instIdx,
                                            });
                                        }
                                    });
                            }
                            if (
                                item.productImageUrl &&
                                !seenUrls.has(item.productImageUrl)
                            ) {
                                seenUrls.add(item.productImageUrl);
                                photos.push({
                                    url: item.productImageUrl,
                                    instanceIndex: instIdx,
                                });
                            }
                            if (
                                item.packingImageUrl &&
                                !seenUrls.has(item.packingImageUrl)
                            ) {
                                seenUrls.add(item.packingImageUrl);
                                photos.push({
                                    url: item.packingImageUrl,
                                    instanceIndex: instIdx,
                                });
                            }
                        }
                    });
                });
                setDetailPackingPhotos(photos);
            },
            () => setDetailPackingPhotos([]),
        );
        return unsub;
    }, [selectedModuleDetail?.id]);

    const [isPC, setIsPC] = useState(() => window.innerWidth >= 1024);
    useEffect(() => {
        const mq = window.matchMedia("(min-width: 1024px)");
        const handler = (e: MediaQueryListEvent) => setIsPC(e.matches);
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
    }, []);
    const [showShelfCheckModal, setShowShelfCheckModal] = useState(false);
    const [checkedShelfIds, setCheckedShelfIds] = useState<{
        [id: string]: boolean;
    }>({});
    const [savingShelfCheck, setSavingShelfCheck] = useState(false);
    const isEligibleForShelfCheck =
        hasRole("admin") || userProfile?.ten_that?.trim() === "Nguyễn Hoàng";

    const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
    const [isUpdatingOrder, setIsUpdatingOrder] = useState(false);
    const [localProjectOrder, setLocalProjectOrder] = useState<
        Record<string, number>
    >({});

    const handleDragStart = (e: React.DragEvent, index: number) => {
        setDraggedIdx(index);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", index.toString());
    };

    const handleDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
    };

    const handleDrop = async (e: React.DragEvent, targetIndex: number) => {
        e.preventDefault();
        if (draggedIdx === null || draggedIdx === targetIndex) {
            setDraggedIdx(null);
            return;
        }

        const sourceIndex = draggedIdx;
        setDraggedIdx(null);

        const reordered = [...projects];
        const [removed] = reordered.splice(sourceIndex, 1);
        reordered.splice(targetIndex, 0, removed);

        const newOrder: Record<string, number> = {};
        reordered.forEach((proj, idx) => {
            newOrder[proj.code] = idx;
        });
        setLocalProjectOrder(newOrder);

        try {
            setIsUpdatingOrder(true);
            const tasks: Promise<void>[] = [];
            reordered.forEach((proj, idxOrder) => {
                const task = findProjectConfigId(proj.code).then((configId) => {
                    if (configId) {
                        return updateDoc(doc(db, "projectConfigs", configId), {
                            projectOrder: idxOrder,
                        }).catch(() => {});
                    }
                });
                tasks.push(task);
            });

            await Promise.all(tasks);
        } catch (err) {
            console.error("Lỗi cập nhật thứ tự dự án:", err);
            alert(
                t("Không thể cập nhật thứ tự dự án") + ": " +
                    (err instanceof Error ? err.message : String(err)),
            );
        } finally {
            setIsUpdatingOrder(false);
        }
    };

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (
                moduleMenuRef.current &&
                !moduleMenuRef.current.contains(e.target as Node)
            ) {
                setShowModuleMenu(false);
            }
        };
        if (showModuleMenu) {
            document.addEventListener("mousedown", handleClickOutside);
        }
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [showModuleMenu]);

    useEffect(() => {
        setClusterFilter(null);
        setStatusFilter(null);
        setModuleSearchQuery('');
    }, [selectedProject]);

    const handleDeleteProject = async () => {
        if (!selectedProject) return;
        try {
            const entriesToDelete = projectEntries.filter(
                (p) => p.projectCode === selectedProject,
            );
            const activityQuery = query(
                collection(db, "activities"),
                where("projectCode", "==", selectedProject),
            );
            const activitySnap = await getDocs(activityQuery);

            const batch = writeBatch(db);
            activitySnap.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });
            await batch.commit();

            await batchDeleteProjectModules(
                entriesToDelete.map((e) => e.id),
                selectedProject,
            );
            await deleteProjectConfigAndModules(selectedProject);

            const displayLabel = userProfile?.ten_that
                ? `${userProfile.ten_that} (${userProfile.chuc_danh || "NV"})`
                : user?.displayName || "Anonymous";

            await addDoc(collection(db, "activities"), {
                userId: user?.uid,
                userName: displayLabel,
                userEmail: user?.email || "",
                action: "Xóa dự án",
                details: `Xóa dự án mã: ${selectedProject}`,
                timestamp: serverTimestamp(),
            });

            setSelectedProject(null);
        } catch (error) {
            handleFirestoreError(
                error,
                OperationType.DELETE,
                "projects/activities",
            );
        }
    };

    const handleCompleteProject = async () => {
        if (!selectedProject) return;
        const proj = projects.find((p) => p.code === selectedProject);
        const isCurrentlyCompleted = proj?.isCompleted;

        if (
            !window.confirm(
                isCurrentlyCompleted
                    ? `${t("Bỏ đánh dấu hoàn tất dự án")} "${selectedProject}"? ${t("Dự án sẽ quay lại danh sách hoạt động.")}`
                    : `${t("Đánh dấu dự án")} "${selectedProject}" ${t("là")} ${t("HOÀN TẤT")}? ${t("Dự án sẽ được ẩn khỏi thống kê và xếp xuống cuối danh sách.")}`,
            )
        )
            return;

        try {
            setCompletingProject(true);
            await markProjectCompleted(selectedProject, !isCurrentlyCompleted);

            // Cập nhật local state ngay lập tức
            setProjectEntries((prev) =>
                prev.map((e) =>
                    e.projectCode === selectedProject
                        ? {
                              ...e,
                              isCompleted: !isCurrentlyCompleted,
                              completedAt: !isCurrentlyCompleted
                                  ? new Date()
                                  : null,
                          }
                        : e,
                ),
            );
        } catch (err) {
            console.error("Lỗi đánh dấu hoàn tất:", err);
            alert(t("Không thể cập nhật trạng thái dự án. Vui lòng thử lại."));
        } finally {
            setCompletingProject(false);
        }
    };

    const handleBulkDeleteModules = async () => {
        if (selectedModuleIds.length === 0 || !selectedProject) return;
        try {
            const deletedModulesCodes: string[] = [];

            selectedModuleIds.forEach((id) => {
                const entry = projectEntries.find((p) => p.id === id);
                if (entry) {
                    deletedModulesCodes.push(entry.moduleCode);
                }
            });

            await batchDeleteProjectModules(selectedModuleIds, selectedProject);

            const displayLabel = userProfile?.ten_that
                ? `${userProfile.ten_that} (${userProfile.chuc_danh || "NV"})`
                : user?.displayName || "Anonymous";

            await addDoc(collection(db, "activities"), {
                userId: user?.uid,
                userName: displayLabel,
                userEmail: user?.email || "",
                action: "Xóa nhiều module",
                details: `Xóa danh sách các module: ${deletedModulesCodes.join(", ")} từ dự án: ${selectedProject}`,
                projectCode: selectedProject,
                timestamp: serverTimestamp(),
            });

            setSelectedModuleIds([]);
            setIsSelectMode(false);
            setShowBulkDeleteConfirm(false);
        } catch (error) {
            handleFirestoreError(
                error,
                OperationType.DELETE,
                "projects/activities",
            );
        }
    };

    const handleShelfCheckComplete = async () => {
        try {
            setSavingShelfCheck(true);
            const displayLabel = userProfile?.ten_that
                ? `${userProfile.ten_that}`
                : user?.displayName || user?.email || "Unknown";

            const shelfUpdates: {
                moduleId: string;
                data: any;
                projectCode?: string;
            }[] = [];

            for (const { shelf } of thungWithShelves) {
                const isChecked = !!checkedShelfIds[shelf.id];
                const newStatus = isChecked
                    ? "Giao Nhận - Đã nhận"
                    : "Kiểm lại";
                const newReceivedQty = isChecked ? shelf.quantity || 1 : 0;

                const history = [...(shelf.statusHistory || [])];
                const lastInHistory =
                    history.length > 0
                        ? history[history.length - 1].split("|")[0]
                        : "";

                if (
                    shelf.status !== newStatus ||
                    shelf.receivedQuantity !== newReceivedQty
                ) {
                    const updateData: any = {
                        status: newStatus,
                        receivedQuantity: newReceivedQty,
                    };

                    if (lastInHistory !== newStatus) {
                        history.push(`${newStatus}|${Date.now()}`);
                        updateData.statusHistory = history;
                    }

                    shelfUpdates.push({
                        moduleId: shelf.id,
                        data: updateData,
                        projectCode: shelf.projectCode,
                    });
                }
            }

            await batchUpdateProjectModules(shelfUpdates);

            await addDoc(collection(db, "activities"), {
                userId: user?.uid,
                userName: displayLabel,
                userEmail: user?.email || "",
                action: "Kiểm Đợt di động",
                details: `Cập nhật trạng thái đợt di động cho dự án ${selectedProject}.`,
                projectCode: selectedProject,
                timestamp: serverTimestamp(),
            });

            setShowShelfCheckModal(false);
        } catch (err) {
            console.error(err);
            alert(
                t("Lỗi lưu kết quả kiểm đợt di động") + ": " +
                    (err instanceof Error ? err.message : String(err)),
            );
        } finally {
            setSavingShelfCheck(false);
        }
    };

    const projects = useMemo(() => {
        const list = Array.from(
            new Set(projectEntries.map((p) => p.projectCode)),
        ).map((code) => {
            const entries = projectEntries.filter(
                (p) => p.projectCode === code,
            );
            const entry = entries[0];

            const statusSummary = entries.reduce((acc: any, curr) => {
                const status = curr.status || t("Chưa nhận");
                const lastPart = status.split(" - ").pop() || t("Chưa nhận");
                acc[lastPart] =
                    (acc[lastPart] || 0) + (Number(curr.quantity) || 0);
                return acc;
            }, {});

            // Sắp xếp trạng thái mới nhất dựa trên statusHistory của tất cả các cấu kiện trong dự án
            let absoluteLatestStatus = t("Chưa nhận");
            let maxTimestamp = 0;

            entries.forEach((e) => {
                if (
                    e.status &&
                    (absoluteLatestStatus === t("Chưa nhận") ||
                        absoluteLatestStatus === t("Chưa có trạng thái"))
                ) {
                    absoluteLatestStatus = e.status;
                }

                if (e.statusHistory && e.statusHistory.length > 0) {
                    e.statusHistory.forEach((h) => {
                        const parts = h.split("|");
                        const statusValue = parts[0]?.trim();
                        const timeStr = parts[1];
                        const ts = timeStr ? parseInt(timeStr, 10) : 0;
                        if (ts > maxTimestamp && statusValue) {
                            maxTimestamp = ts;
                            absoluteLatestStatus = statusValue;
                        }
                    });
                }
            });

            const totalAccessories = entries.reduce((acc, curr) => {
                return (
                    acc +
                    (curr.accessories?.reduce((a, c) => a + c.quantity, 0) || 0)
                );
            }, 0);

            // Differentiation logic
            const constructionEntries = entries.filter((e) => {
                if (
                    (e.classification as string) === "Phụ kiện" ||
                    e.moduleCode?.startsWith("PK-")
                ) {
                    return false;
                }
                return true;
            });

            const moduleEntries = constructionEntries.filter(
                (e) => !!(e.pWidth || e.pDepth || e.pHeight),
            );
            const detailEntries = constructionEntries.filter(
                (e) => !(e.pWidth || e.pDepth || e.pHeight),
            );

            const moduleCount = moduleEntries.reduce(
                (acc, curr) => acc + (Number(curr.quantity) || 0),
                0,
            );
            const detailCount = detailEntries.reduce(
                (acc, curr) => acc + (Number(curr.quantity) || 0),
                0,
            );
            const receivedModuleCount = moduleEntries.reduce(
                (acc, curr) =>
                    acc +
                    Math.min(
                        Number(curr.quantity) || 0,
                        curr.receivedQuantity || 0,
                    ),
                0,
            );
            const receivedDetailCount = detailEntries.reduce(
                (acc, curr) =>
                    acc +
                    Math.min(
                        Number(curr.quantity) || 0,
                        curr.receivedQuantity || 0,
                    ),
                0,
            );

            const totalCount = moduleCount + detailCount;
            const receivedTotalCount =
                receivedModuleCount + receivedDetailCount;
            const allReceived =
                totalCount > 0 && receivedTotalCount >= totalCount;
            const displayPercent = allReceived
                ? 100
                : totalCount > 0
                  ? Math.round((receivedTotalCount / totalCount) * 100)
                  : 0;

            // Simple count across ALL entries (matching project detail view logic)
            const totalAllEntries = entries.reduce(
                (acc, curr) => acc + (Number(curr.quantity) || 0),
                0,
            );
            const receivedAllEntries = entries.reduce(
                (acc, curr) => acc + (Number(curr.receivedQuantity) || 0),
                0,
            );
            const detailDisplayPercent =
                totalAllEntries > 0
                    ? receivedAllEntries >= totalAllEntries
                        ? 100
                        : Math.round(
                              (receivedAllEntries / totalAllEntries) * 100,
                          )
                    : 0;

            return {
                code,
                drawingUrl: entry?.drawingUrl,
                assemblyDrawingUrl: entry?.assemblyDrawingUrl,
                glbUrl: entry?.glbUrl,
                name: formatProjectName(entry?.projectName) || t("Không tên"),
                totalCount,
                moduleCount,
                detailCount,
                receivedModuleCount,
                receivedDetailCount,
                receivedTotalCount,
                displayPercent,
                detailDisplayPercent,
                totalAllEntries,
                receivedAllEntries,
                totalAccessories,
                statusSummary,
                latestStatus: absoluteLatestStatus,
                createdAt: entry?.createdAt,
                projectOrder: entries.find((e) => e.projectOrder !== undefined)
                    ?.projectOrder,
                isCompleted: entries.some((e) => e.isCompleted),
                completedAt: entries.find((e) => e.completedAt)?.completedAt,
            };
        });

        // Sắp xếp: projects đang hoạt động lên trên, projects hoàn tất xuống dưới
        return list.sort((a, b) => {
            if (a.isCompleted !== b.isCompleted) {
                return a.isCompleted ? 1 : -1;
            }

            const orderA =
                localProjectOrder[a.code] ?? a.projectOrder ?? Infinity;
            const orderB =
                localProjectOrder[b.code] ?? b.projectOrder ?? Infinity;

            if (orderA !== orderB) {
                return orderA - orderB;
            }

            const timeA =
                a.createdAt?.seconds || a.createdAt?.toMillis?.() || 0;
            const timeB =
                b.createdAt?.seconds || b.createdAt?.toMillis?.() || 0;

            if (timeA !== timeB) {
                return timeA - timeB;
            }

            return a.code.localeCompare(b.code, "vi", { numeric: true });
        });
    }, [projectEntries, localProjectOrder]);

    const toggleSelection = (id: string) => {
        setSelectedModuleIds((prev) => {
            const next = prev.includes(id)
                ? prev.filter((i) => i !== id)
                : [...prev, id];
            return next;
        });
    };

    const handleRowClick = (entry: ProjectEntry) => {
        if (isSelectMode) {
            toggleSelection(entry.id);
        } else if (isPC) {
            setSelectedModuleDetail(entry);
        } else {
            setSelectedModuleId(entry.id);
        }
    };

    const getModuleGlbUrl = (entry: ProjectEntry): string => {
        return (
            projectEntries.find(
                (p) => p.projectCode === entry.projectCode && p.glbUrl,
            )?.glbUrl ||
            entry.glbUrl ||
            ""
        );
    };

    const rawEntries = useMemo(() => {
        if (!selectedProject) return [];
        return projectEntries
            .filter((p) => p.projectCode === selectedProject)
            .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
    }, [projectEntries, selectedProject]);

    // All packing photos for the entire project (for "Ảnh hoàn thiện" modal)
    const [allProjectPackingPhotos, setAllProjectPackingPhotos] = useState<
        { url: string; moduleCode: string; cluster: string; instanceIndex?: number; source: string }[]
    >([]);
    useEffect(() => {
        if (!selectedProject) {
            setAllProjectPackingPhotos([]);
            return;
        }
        // Query packing theo projectCode để lấy đúng phiếu đóng gói của dự án
        const q = query(collection(db, "packing"), where("projectCode", "==", selectedProject));
        const unsub = onSnapshot(
            q,
            (snap) => {
                const moduleEntries = rawEntries.map((e) => ({
                    id: e.id || "",
                    code: (e.moduleCode || "")
                        .replace(/\s*#\d+\/\d+$/, "")
                        .trim()
                        .toLowerCase(),
                    cluster: e.cluster || "",
                }));
                const photos: {
                    url: string;
                    moduleCode: string;
                    cluster: string;
                    instanceIndex?: number;
                    source: string;
                }[] = [];
                const seenUrls = new Set<string>();
                snap.docs.forEach((d) => {
                    const list = d.data() as any;
                    (list.items || []).forEach((item: any) => {
                        const itemName = (item.name || "").toLowerCase().trim();
                        const itemCode = itemName
                            .replace(/\s*#\d+\/\d+$/, "")
                            .trim();
                        const itemId = item.id || "";
                        const matchedEntry = moduleEntries.find(
                            (e) =>
                                e.code === itemCode ||
                                itemName.includes(e.code) ||
                                e.code.includes(itemCode) ||
                                (itemId && e.id && itemId.startsWith(e.id)),
                        );
                        if (!matchedEntry) return;
                        const instIdx = item.instanceIndex;
                        const cluster =
                            matchedEntry.cluster || t("Chưa phân cụm");
                        const moduleName = item.name || itemCode;
                        const clusterPhotoSet = new Set(item.clusterPhotos || []);
                        const addUrl = (url: string, source: string) => {
                            if (url && !seenUrls.has(url)) {
                                seenUrls.add(url);
                                photos.push({
                                    url,
                                    moduleCode: moduleName,
                                    cluster,
                                    instanceIndex: instIdx,
                                    source,
                                });
                            }
                        };
                        (item.photos || [])
                            .filter(Boolean)
                            .forEach((p: string) => {
                                const src = clusterPhotoSet.has(p) ? "cluster" : "packing";
                                addUrl(p, src);
                            });
                        if (item.productImageUrl)
                            addUrl(item.productImageUrl, "packing");
                        if (item.packingImageUrl)
                            addUrl(item.packingImageUrl, "packing");
                    });
                });
                setAllProjectPackingPhotos(photos);
            },
            () => setAllProjectPackingPhotos([]),
        );
        return unsub;
    }, [selectedProject, rawEntries]);

    // All photos grouped by cluster (QC + Packing)
    const photosByCluster = useMemo(() => {
        const grouped: Record<
            string,
            { url: string; label: string; moduleCode: string; source: string }[]
        > = {};

        const addPhoto = (
            cluster: string,
            url: string,
            label: string,
            moduleCode: string,
            source: string,
        ) => {
            if (!grouped[cluster]) grouped[cluster] = [];
            if (!grouped[cluster].some((p) => p.url === url)) {
                grouped[cluster].push({ url, label, moduleCode, source });
            }
        };

        const qcStages = [
            { field: "qcWhite", short: t("Trắng") },
            { field: "qcPaint", short: t("Sơn") },
            { field: "qcFinish", short: "HT" },
            { field: "qcPack", short: t("Gói") },
        ];

        rawEntries.forEach((entry) => {
            const cluster = entry.cluster || t("Chưa phân cụm");
            const instances = getModuleInstances(entry);

            instances.forEach((inst) => {
                const idx = (inst as any).instanceIndex || 0;
                qcStages.forEach(({ field, short }) => {
                    const qcData = (inst as any)[field];
                    if (
                        qcData &&
                        qcData.status !== "fail" &&
                        qcData.photos?.length
                    ) {
                        qcData.photos.forEach((p: string) =>
                            addPhoto(
                                cluster,
                                p,
                                `#${idx} QC ${short}`,
                                entry.moduleCode || "",
                                "qc",
                            ),
                        );
                    }
                });
            });

            // Module-level QC fallback
            if (
                instances.length === 0 ||
                !instances.some((inst) =>
                    qcStages.some(
                        (s) =>
                            (inst as any)[s.field]?.photos?.length > 0 &&
                            (inst as any)[s.field]?.status !== "fail",
                    ),
                )
            ) {
                qcStages.forEach(({ field, short }) => {
                    const stageKey = field.replace("qc", "").toLowerCase() as any;
                    const data = getModuleQcAggregate(entry, stageKey);
                    if (
                        data &&
                        data.status !== "fail" &&
                        data.photos?.length
                    ) {
                        data.photos.forEach((p: string) =>
                            addPhoto(
                                cluster,
                                p,
                                `QC ${short}`,
                                entry.moduleCode || "",
                                "qc",
                            ),
                        );
                    }
                });
            }
        });

        // Packing photos
        allProjectPackingPhotos.forEach((p) => {
            addPhoto(
                p.cluster || t("Chưa phân cụm"),
                p.url,
                t("Đóng gói"),
                p.moduleCode,
                p.source || "packing",
            );
        });

        return grouped;
    }, [rawEntries, allProjectPackingPhotos]);

    const totalProjectPhotos = useMemo(() => {
        return Object.values(photosByCluster).reduce(
            (sum, photos) => sum + photos.length,
            0,
        );
    }, [photosByCluster]);

    // Đồng bộ selectedModuleDetail khi danh sách rawEntries thay đổi (ví dụ khi sửa bằng Excel)
    useEffect(() => {
        if (selectedModuleDetail) {
            const updated = rawEntries.find(
                (e) => e.id === selectedModuleDetail.id,
            );
            if (updated) {
                setSelectedModuleDetail(updated);
            } else {
                setSelectedModuleDetail(null);
            }
        }
    }, [rawEntries]);

    const clusters = useMemo(() => {
        return Array.from(new Set(rawEntries.map((e) => e.cluster)))
            .filter((v): v is string => !!v)
            .sort();
    }, [rawEntries]);

    const statuses = useMemo(() => {
        return Array.from(
            new Set(
                rawEntries.map((e) =>
                    e.status ? e.status.split(" - ").pop() : "N/A",
                ),
            ),
        )
            .filter((v): v is string => !!v)
            .sort();
    }, [rawEntries]);

    const thungWithShelves = useMemo(() => {
        if (!selectedProject || !rawEntries) return [];
        // 1. Lọc ra các module Thùng
        const thungModules = rawEntries.filter(
            (e) => getEntryType(e) === "Thùng",
        );

        // 2. Ánh xạ từng Thùng với "Đợt di động" tương ứng
        const list: { thung: any; shelf: any }[] = [];
        thungModules.forEach((thung) => {
            const shelfCode = makeShelfModuleCode(thung.moduleCode);
            const shelfModule = rawEntries.find(
                (e) =>
                    e.moduleCode === shelfCode &&
                    getEntryType(e) === "Đợt di động",
            );
            if (shelfModule) {
                list.push({ thung, shelf: shelfModule });
            }
        });
        return list;
    }, [rawEntries, selectedProject]);

    useEffect(() => {
        if (showShelfCheckModal) {
            const initialChecked: { [id: string]: boolean } = {};
            thungWithShelves.forEach(({ shelf }) => {
                initialChecked[shelf.id] =
                    shelf.status?.includes("Đã nhận") || false;
            });
            setCheckedShelfIds(initialChecked);
        }
    }, [showShelfCheckModal, thungWithShelves]);

    useEffect(() => {
        if (selectedProject && setHeaderContent) {
            setHeaderContent({
                backButton: (
                    <button
                        type="button"
                        onClick={() => setSelectedProject(null)}
                        className="p-2.5 bg-slate-100 border border-slate-200 text-slate-500 hover:text-indigo-700 rounded-lg transition-all active:scale-95 shadow-none cursor-pointer flex items-center justify-center shrink-0"
                    >
                        <ArrowLeft size={16} />
                    </button>
                ),
                title: (
                    <div className="flex flex-col min-w-0">
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest truncate leading-none mb-0.5">
                            {rawEntries[0]?.projectCode || selectedProject}
                        </span>
                        <h1 className="text-xs lg:text-sm font-black text-slate-900 uppercase tracking-tight truncate leading-none">
                            {formatProjectName(rawEntries[0]?.projectName) ||
                                t("Chi Tiết Dự Án")}
                        </h1>
                    </div>
                ),
                actions: (
                    <div className="flex items-center gap-1.5 overflow-x-auto py-1 scrollbar-hide shrink-0 animate-none">
                        {clusterFilter && (
                            <button
                                type="button"
                                onClick={() => setClusterFilter(null)}
                                className="shrink-0 flex items-center space-x-1 px-2 py-1 bg-indigo-100 text-indigo-600 rounded-lg text-[9px] font-black border border-indigo-100 cursor-pointer"
                            >
                                <span>
                                    {t("CỤM")}: {clusterFilter}
                                </span>
                                <X size={10} />
                            </button>
                        )}
                        {statusFilter && (
                            <button
                                type="button"
                                onClick={() => setStatusFilter(null)}
                                className="shrink-0 flex items-center space-x-1 px-2 py-1 bg-emerald-100 text-emerald-600 rounded-lg text-[9px] font-black border border-emerald-100 cursor-pointer"
                            >
                                <span>
                                    {t("TRẠNG THÁI")}: {statusFilter}
                                </span>
                                <X size={10} />
                            </button>
                        )}

                        {/* HIỂN THỊ CÁC NÚT ĐƯỢC CHUYỂN HOÀN TOÀN LÊN HEADER ĐỂ TIN GỌN */}
                        {rawEntries[0]?.glbUrl &&
                            rawEntries[0].glbUrl.trim() !== "" && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowNativeViewer({
                                            url: rawEntries[0].glbUrl,
                                            drawingUrl:
                                                rawEntries[0].drawingUrl || "",
                                            clusters,
                                            entries: rawEntries,
                                        })
                                    }
                                    className="shrink-0 flex items-center space-x-1 px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer shadow-none active:scale-95"
                                >
                                    <Boxes
                                        size={11}
                                        className="mr-0.5 shrink-0"
                                    />
                                    <span>{t("Mô hình 3D")}</span>
                                </button>
                            )}
                        {rawEntries[0]?.drawingUrl &&
                            rawEntries[0].drawingUrl.trim() !== "" && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowNativeViewer({
                                            url: rawEntries[0].glbUrl || "",
                                            drawingUrl:
                                                rawEntries[0].drawingUrl || "",
                                            clusters,
                                            entries: rawEntries,
                                            viewMode: "pdf",
                                        })
                                    }
                                    className="shrink-0 flex items-center space-x-1 px-2.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer active:scale-95"
                                >
                                    <FileSearch
                                        size={11}
                                        className="mr-0.5 shrink-0"
                                    />
                                    <span>{t("Bản vẽ PDF")}</span>
                                </button>
                            )}
                        {canPrintLabel && (
                            <button
                                type="button"
                                onClick={() => setShowTempLabels(true)}
                                className="hidden lg:flex shrink-0 flex items-center space-x-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[9px] font-black uppercase tracking-wider transition-all active:scale-95 shadow-none cursor-pointer"
                                title={t("In tem tạm cho cấu kiện dạng Thùng")}
                            >
                                <CreditCard
                                    size={11}
                                    className="mr-1 shrink-0"
                                />
                                <span>{t("In Tem Tạm")}</span>
                            </button>
                        )}
                        {/* <button
  type="button"
  onClick={() => setShowShelfCheckModal(true)}
  className="shrink-0 flex items-center space-x-1 px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-[9px] font-black uppercase tracking-wider transition-all active:scale-95 shadow-none cursor-pointer"
  title="Khớp đủ hoặc bắt lỗi các đợt di động cho các thùng trong dự án"
  >
  <CheckSquare
  size={11}
  className="mr-1 shrink-0"
  />
  <span>Check Đợt Di Động</span>
  </button> */}
                        {isAdmin && (
                            <>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowExcelEditorModal(true)
                                    }
                                    className="hidden lg:flex shrink-0 flex items-center space-x-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[9px] font-black uppercase tracking-wider transition-all active:scale-95 shadow-none cursor-pointer"
                                    title={t(
                                        "Chỉnh sửa chi tiết module dự án dưới dạng bảng Excel",
                                    )}
                                >
                                    <TableIcon
                                        size={11}
                                        className="mr-1 shrink-0"
                                    />
                                    <span>{t("Chỉnh Excel")}</span>
                                </button>
                                {isAdmin && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setShowEditProjectInfoModal(true)
                                        }
                                        className="hidden lg:flex shrink-0 items-center space-x-1 px-2.5 py-1.5 bg-white hover:bg-slate-100 text-emerald-600 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all border border-emerald-200 cursor-pointer shadow-none active:scale-95"
                                    >
                                        <FileEdit
                                            size={11}
                                            className="mr-0.5 shrink-0"
                                        />
                                        <span>{t("Sửa Dự Án")}</span>
                                    </button>
                                )}
                                <div className="hidden lg:flex flex items-center bg-white rounded-lg border border-slate-200 overflow-hidden shadow-none shrink-0 h-7">
                                    <button
                                        type="button"
                                        onClick={handleCompleteProject}
                                        disabled={completingProject}
                                        className={`h-full px-2 transition-colors cursor-pointer flex items-center justify-center rounded-lg ${
                                            projects.find(
                                                (p) =>
                                                    p.code === selectedProject,
                                            )?.isCompleted
                                                ? "text-amber-500 hover:text-amber-600"
                                                : "text-slate-400 hover:text-emerald-500"
                                        }`}
                                        title={
                                            projects.find(
                                                (p) =>
                                                    p.code === selectedProject,
                                            )?.isCompleted
                                                ? t("Bỏ đánh dấu hoàn tất")
                                                : t("Đánh dấu hoàn tất dự án")
                                        }
                                    >
                                        {completingProject ? (
                                            <Loader2
                                                size={12}
                                                className="animate-spin"
                                            />
                                        ) : (
                                            <CheckCircle size={12} />
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setShowDeleteModal(true)}
                                        className="h-full px-2 text-slate-400 hover:text-red-500 transition-colors cursor-pointer flex items-center justify-center rounded-lg"
                                        title={t("Xóa dự án")}
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                ),
            });
        }

        return () => {
            if (setHeaderContent) {
                setHeaderContent(null);
            }
        };
    }, [
        selectedProject,
        rawEntries,
        clusterFilter,
        statusFilter,
        isEligibleForShelfCheck,
        isAdmin,
        canPrintLabel,
        completingProject,
        projects,
        setHeaderContent,
        setSelectedProject,
        setShowNativeViewer,
        setShowEditProjectInfoModal,
        setShowShelfCheckModal,
        setShowExcelEditorModal,
        setShowTempLabels,
        setShowDeleteModal,
    ]);

    const entries = useMemo(() => {
        const matchesClusterAndStatus = (e: any) => {
            const matchesCluster = clusterFilter
                ? e.cluster === clusterFilter
                : true;
            const currentStatus = e.status
                ? e.status.split(" - ").pop()
                : "N/A";
            const matchesStatus = statusFilter
                ? currentStatus === statusFilter
                : true;
            // Lọc theo tên kiện (moduleCode, tên tùy chỉnh hoặc tên hiển thị)
            const q = moduleSearchQuery.trim().toLowerCase();
            const matchesSearch = !q || 
                (e.moduleCode || '').toLowerCase().includes(q) ||
                (e.moduleName || e.name || '').toLowerCase().includes(q) ||
                (e.displayName || '').toLowerCase().includes(q);
            return matchesCluster && matchesStatus && matchesSearch;
        };

        if (moduleTab === "thung") {
            const list = rawEntries.filter((e) => {
                if (
                    (e.classification as string) === "Phụ kiện" ||
                    e.moduleCode?.startsWith("PK-")
                ) {
                    return false;
                }
                const type = getEntryType(e);
                if (type === "Len, Filler" || type === "CTHT") {
                    return false;
                }
                return matchesClusterAndStatus(e);
            });

            const tree = buildAndSortTree(list);

            if (!showChildren) {
                return tree.filter((t) => !t.isChild);
            }
            return tree;
        } else if (moduleTab === "ctht") {
            const list = rawEntries.filter((e) => {
                if (
                    (e.classification as string) === "Phụ kiện" ||
                    e.moduleCode?.startsWith("PK-")
                ) {
                    return false;
                }
                const type = getEntryType(e);
                if (type !== "CTHT") {
                    return false;
                }
                return matchesClusterAndStatus(e);
            });

            return buildAndSortTree(list);
        } else if (moduleTab === "lenFiller") {
            const list = rawEntries.filter((e) => {
                if (
                    (e.classification as string) === "Phụ kiện" ||
                    e.moduleCode?.startsWith("PK-")
                ) {
                    return false;
                }
                const type = getEntryType(e);
                if (type !== "Len, Filler") {
                    return false;
                }
                return matchesClusterAndStatus(e);
            });

            return buildAndSortTree(list);
        } else if (moduleTab === "phukien") {
            return rawEntries.filter((e) => {
                const isAcc =
                    (e.classification as string) === "Phụ kiện" ||
                    e.moduleCode?.startsWith("PK-");
                const matchesCluster = clusterFilter
                    ? e.cluster === clusterFilter
                    : true;
                const currentStatus = e.status
                    ? e.status.split(" - ").pop()
                    : "N/A";
                const matchesStatus = statusFilter
                    ? currentStatus === statusFilter
                    : true;

                return isAcc && matchesCluster && matchesStatus;
            });
        }

        return [];
    }, [rawEntries, clusterFilter, statusFilter, moduleTab, showChildren, moduleSearchQuery]);

    const thungCount = useMemo(() => {
        return rawEntries.filter((e) => {
            if (
                (e.classification as string) === "Phụ kiện" ||
                e.moduleCode?.startsWith("PK-")
            ) {
                return false;
            }
            const type = getEntryType(e);
            if (type === "Len, Filler" || type === "CTHT") {
                return false;
            }
            return true;
        }).length;
    }, [rawEntries]);

    const cthtCount = useMemo(() => {
        return rawEntries.filter((e) => {
            if (
                (e.classification as string) === "Phụ kiện" ||
                e.moduleCode?.startsWith("PK-")
            ) {
                return false;
            }
            return getEntryType(e) === "CTHT";
        }).length;
    }, [rawEntries]);

    const lenFillerEntries = useMemo(() => {
        return rawEntries.filter((e) => {
            if (
                (e.classification as string) === "Phụ kiện" ||
                e.moduleCode?.startsWith("PK-")
            ) {
                return false;
            }
            return getEntryType(e) === "Len, Filler";
        });
    }, [rawEntries]);

    const phukienEntries = useMemo(() => {
        return rawEntries.filter((e) => {
            return (
                (e.classification as string) === "Phụ kiện" ||
                e.moduleCode?.startsWith("PK-")
            );
        });
    }, [rawEntries]);

    const allClusters = useMemo(() => {
        const set = new Set<string>();
        rawEntries.forEach((e) => {
            if (
                (e.classification as string) === "Phụ kiện" ||
                e.moduleCode?.startsWith("PK-")
            ) {
                return;
            }
            if (e.cluster) {
                set.add(e.cluster.trim());
            }
        });
        return Array.from(set).sort((a, b) => a.localeCompare(b, "vi"));
    }, [rawEntries]);

    const tempLabelsModules = useMemo(() => {
        return rawEntries.filter((e) => {
            if (
                (e.classification as string) === "Phụ kiện" ||
                e.moduleCode?.startsWith("PK-")
            ) {
                return false;
            }
            const isThung = getEntryType(e) === "Thùng";
            const hasDot =
                e.moduleCode?.toLowerCase().includes("đợt") ||
                e.moduleCode?.toLowerCase().includes("dot");
            return isThung && !hasDot;
        });
    }, [rawEntries]);

    const projectAccessories = useMemo(() => {
        return Array.from(
            new Set(
                rawEntries
                    .flatMap((e) => e.accessories || [])
                    .map((a) => a.name),
            ),
        );
    }, [rawEntries]);

    const accessorySummary = useMemo(() => {
        const accMap = rawEntries.reduce((acc: any, entry) => {
            entry.accessories?.forEach((a) => {
                if (!acc[a.name])
                    acc[a.name] = { total: 0, issued: 0, status: "" };
                acc[a.name].total += a.quantity;
                acc[a.name].issued += a.issuedQuantity || 0;
                if (a.status) acc[a.name].status = a.status;
            });
            return acc;
        }, {});

        return Object.entries(accMap).sort(([nameA], [nameB]) => {
            const lowerA = String(nameA).toLowerCase();
            const lowerB = String(nameB).toLowerCase();
            const isShelfA =
                lowerA.includes("đợt di động") && !lowerA.includes("chốt");
            const isShelfB =
                lowerB.includes("đợt di động") && !lowerB.includes("chốt");
            const isPinA = lowerA.includes("chốt đợt");
            const isPinB = lowerB.includes("chốt đợt");

            if (isShelfA && !isShelfB) return -1;
            if (!isShelfA && isShelfB) return 1;
            if (isPinA && !isPinB) return -1;
            if (!isPinA && isPinB) return 1;
            return lowerA.localeCompare(lowerB);
        });
    }, [rawEntries]);

    // Thêm hàm này vào trước khối "if (selectedProject) {"
    const getQCPassCount = (entry: ProjectEntry) => {
        let count = 0;
        if (getModuleQcAggregate(entry, "white")?.status === "pass") count++;
        if (getModuleQcAggregate(entry, "paint")?.status === "pass") count++;
        if (getModuleQcAggregate(entry, "finish")?.status === "pass") count++;
        if (getModuleQcAggregate(entry, "pack")?.status === "pass") count++;
        return count;
    };

    // Preload GLB khi vào chi tiết dự án
    useEffect(() => {
        if (!selectedProject || rawEntries.length === 0) return;
        const glbUrl =
            rawEntries.find((e) => e.glbUrl?.trim())?.glbUrl?.trim() ||
            projectEntries
                .find((p) => p.projectCode === selectedProject && p.glbUrl)
                ?.glbUrl?.trim();
        if (glbUrl) {
            useGLTF.preload(glbUrl);
        }
    }, [selectedProject, rawEntries, projectEntries]);

    if (selectedProject) {
        const currentModule = selectedModuleId
            ? rawEntries.find((e) => e.id === selectedModuleId)
            : null;

        const isCompletedProject = projects.find(
            (p) => p.code === selectedProject,
        )?.isCompleted;

        return (
            <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500">
                {/* HÀNG THỐNG KÊ (STATS CARDS) SIÊU TIN GỌN */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {/* Ảnh hoàn thiện */}
                    <button
                        type="button"
                        onClick={() => setShowAllPhotosModal(true)}
                        className="bg-white p-3 rounded-lg border border-slate-200 flex items-center justify-between cursor-pointer hover:bg-slate-100 active:scale-[0.98] transition-all text-left outline-none"
                    >
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
                                <ImageIcon size={16} className="text-violet-600" />
                            </div>
                            <div className="space-y-0.5 text-left">
                                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                                    {t("Ảnh hoàn thiện")}
                                </p>
                                <h3 className="text-lg font-black text-violet-700 leading-none">
                                    {totalProjectPhotos}
                                </h3>
                            </div>
                        </div>
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-lg bg-violet-100 text-violet-600">
                            {Object.keys(photosByCluster).length} {t("cụm")}
                        </span>
                    </button>

                    {/* {t("Tổng số Module")} */}
                    <div className="bg-white p-3 rounded-lg border border-slate-200 flex items-center justify-between">
                        <div className="space-y-0.5 text-left">
                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                                {t("Tổng số Module")}
                            </p>
                            <h3 className="text-lg font-black text-indigo-600 leading-none">
                                {entries.reduce(
                                    (acc, curr) =>
                                        acc + (Number(curr.quantity) || 0),
                                    0,
                                )}
                            </h3>
                        </div>
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-lg bg-indigo-100 text-indigo-600">
                            {entries.length} {t("loại")}
                        </span>
                    </div>

                    {/* Đã nhận */}
                    <button
                        type="button"
                        onClick={() => setShowReceivedStatusModal("received")}
                        className="bg-white p-3 rounded-lg border border-slate-200 flex items-center justify-between cursor-pointer hover:bg-slate-100 active:scale-[0.98] transition-all text-left outline-none"
                    >
                        <div className="space-y-0.5">
                            <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">
                                {t("Đã nhận")}
                            </p>
                            <h3 className="text-lg font-black text-emerald-600 leading-none">
                                {entries.reduce(
                                    (acc, curr) =>
                                        acc +
                                        (Number(curr.receivedQuantity) || 0),
                                    0,
                                )}
                            </h3>
                        </div>
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-lg bg-emerald-100 text-emerald-700">
                            {(() => {
                                const tot = entries.reduce(
                                    (acc, curr) =>
                                        acc + (Number(curr.quantity) || 0),
                                    0,
                                );
                                const rec = entries.reduce(
                                    (acc, curr) =>
                                        acc +
                                        (Number(curr.receivedQuantity) || 0),
                                    0,
                                );
                                return tot > 0
                                    ? `${Math.round((rec / tot) * 100)}%`
                                    : "0%";
                            })()}
                        </span>
                    </button>

                    {/* Chưa nhận */}
                    <button
                        type="button"
                        onClick={() => setShowReceivedStatusModal("unreceived")}
                        className="bg-white p-3 rounded-lg border border-slate-200 flex items-center justify-between cursor-pointer hover:bg-slate-100 active:scale-[0.98] transition-all text-left outline-none"
                    >
                        <div className="space-y-0.5">
                            <p className="text-[9px] font-black text-rose-500 uppercase tracking-widest">
                                {t("Chưa nhận")}
                            </p>
                            <h3 className="text-lg font-black text-rose-600">
                                {(() => {
                                    const filtered = entries.filter((e) => {
                                        const codeLower = (
                                            e.moduleCode || ""
                                        ).toLowerCase();
                                        return (
                                            !codeLower.includes("len") &&
                                            !codeLower.includes("fil")
                                        );
                                    });
                                    const tot = filtered.reduce(
                                        (acc, curr) =>
                                            acc + (Number(curr.quantity) || 0),
                                        0,
                                    );
                                    const rec = filtered.reduce(
                                        (acc, curr) =>
                                            acc +
                                            (Number(curr.receivedQuantity) ||
                                                0),
                                        0,
                                    );
                                    return Math.max(0, tot - rec);
                                })()}
                            </h3>
                        </div>
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-lg bg-rose-100 text-rose-700">
                            {(() => {
                                const filtered = entries.filter((e) => {
                                    const codeLower = (
                                        e.moduleCode || ""
                                    ).toLowerCase();
                                    return (
                                        !codeLower.includes("len") &&
                                        !codeLower.includes("fil")
                                    );
                                });
                                const tot = filtered.reduce(
                                    (acc, curr) =>
                                        acc + (Number(curr.quantity) || 0),
                                    0,
                                );
                                const rec = filtered.reduce(
                                    (acc, curr) =>
                                        acc +
                                        (Number(curr.receivedQuantity) || 0),
                                    0,
                                );
                                const unrec = Math.max(0, tot - rec);
                                return tot > 0
                                    ? `${Math.round((unrec / tot) * 100)}%`
                                    : "0%";
                            })()}
                        </span>
                    </button>

                </div>

                <div className="grid grid-cols-1 lg:grid-cols-11 gap-8">
                    {/* Main Table Card */}
                    <div
                        id="module-section"
                        className="lg:col-span-6 bg-white rounded-lg shadow-none border border-slate-200 overflow-hidden"
                    >
                        <div className="px-6 py-4 bg-white border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <h3 className="text-sm font-black text-slate-700 uppercase tracking-widest flex items-center">
                                <TableIcon
                                    size={18}
                                    className="mr-3 text-indigo-600"
                                />
                                {t("Danh sách Module")}
                                {isSelectMode && (
                                    <span className="ml-2 text-orange-500">
                                        ({t("Đã chọn")}{" "}
                                        {selectedModuleIds.length})
                                    </span>
                                )}
                            </h3>
                            <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
                                    {/* Bộ lọc theo tên kiện */}
                                    <div className="flex items-center bg-slate-100 border border-slate-100 rounded-xl animate-fade-in px-2.5 py-1 h-8 w-full sm:w-auto">
                                        <FileSearch
                                            size={14}
                                            className="text-slate-400 mr-1.5 shrink-0"
                                        />
                                        <input
                                            type="text"
                                            placeholder={t("Tìm tên kiện")}
                                            value={moduleSearchQuery}
                                            onChange={(e) => setModuleSearchQuery(e.target.value)}
                                            className="text-[10px] font-black text-slate-600 bg-transparent outline-none uppercase tracking-widest w-full sm:w-[120px] placeholder:text-slate-300"
                                        />
                                        {moduleSearchQuery && (
                                            <button
                                                onClick={() => setModuleSearchQuery('')}
                                                className="ml-1 text-slate-400 hover:text-slate-600 cursor-pointer"
                                            >
                                                <X size={12} />
                                            </button>
                                        )}
                                    </div>

                                    {/* Bộ lọc theo Cụm */}
                                    <div className="flex items-center bg-slate-100 border border-slate-100 rounded-xl animate-fade-in px-2.5 py-1 h-8 w-full sm:w-auto">
                                        <Boxes
                                            size={14}
                                            className="text-slate-400 mr-1.5 shrink-0"
                                        />
                                        <select
                                            value={clusterFilter || ""}
                                            onChange={(e) =>
                                                setClusterFilter(
                                                    e.target.value || null,
                                                )
                                            }
                                            className="text-[10px] font-black text-slate-600 bg-transparent outline-none uppercase tracking-widest cursor-pointer w-full sm:w-auto sm:max-w-[130px]"
                                        >
                                            <option value="">
                                                {t("Toàn bộ Cụm")}
                                            </option>
                                            {allClusters.map((cluster) => (
                                                <option
                                                    key={cluster}
                                                    value={cluster}
                                                >
                                                    {cluster}
                                                </option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Nút Ẩn/Hiện Cấu kiện con */}
                                    {moduleTab === "thung" && (
                                        <button
                                            onClick={() =>
                                                setShowChildren(!showChildren)
                                            }
                                            className={`flex items-center space-x-1.5 px-2.5 py-1 select-none border rounded-xl h-8 text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 cursor-pointer w-full sm:w-auto ${
                                                showChildren
                                                    ? "bg-indigo-100 border-indigo-100 text-indigo-600 hover:bg-indigo-100/50"
                                                    : "bg-amber-100 border-amber-100 text-amber-600 hover:bg-amber-100/50"
                                            }`}
                                            title={
                                                showChildren
                                                    ? t(
                                                          "Ẩn bớt các cấu kiện con",
                                                      )
                                                    : t(
                                                          "Hiện tất cả cấu kiện con",
                                                      )
                                            }
                                        >
                                            {showChildren ? (
                                                <Eye
                                                    size={14}
                                                    className="shrink-0 text-indigo-500"
                                                />
                                            ) : (
                                                <EyeOff
                                                    size={14}
                                                    className="shrink-0 text-amber-500"
                                                />
                                            )}
                                            <span>
                                                {showChildren
                                                    ? t("Cấu kiện con: Hiện")
                                                    : t("Cấu kiện con: Ẩn")}
                                            </span>
                                        </button>
                                    )}
                                {isAdmin && (
                                    <div
                                        className="relative"
                                        ref={moduleMenuRef}
                                    >
                                        <button
                                            onClick={() =>
                                                setShowModuleMenu(
                                                    !showModuleMenu,
                                                )
                                            }
                                            className="hidden sm:flex items-center justify-center w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 transition-all active:scale-95 cursor-pointer"
                                        >
                                            <MoreVertical size={16} />
                                        </button>
                                        {showModuleMenu && (
                                            <div className="absolute right-0 top-full mt-1 z-100 w-52 bg-white border border-slate-200 rounded-lg shadow-lg py-1 animate-fade-in">
                                                <button
                                                    onClick={() => {
                                                        setShowQuickMergeModal(
                                                            true,
                                                        );
                                                        setShowModuleMenu(
                                                            false,
                                                        );
                                                    }}
                                                    className="w-full flex items-center space-x-2 px-3 py-2 text-[11px] font-semibold text-indigo-600 hover:bg-slate-100 transition-colors cursor-pointer"
                                                >
                                                    <GitMerge
                                                        size={14}
                                                        className="shrink-0"
                                                    />
                                                    <span>
                                                        {t("Ghép Nhanh")}
                                                    </span>
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        setIsSelectMode(
                                                            !isSelectMode,
                                                        );
                                                        setSelectedModuleIds(
                                                            [],
                                                        );
                                                        setShowModuleMenu(
                                                            false,
                                                        );
                                                    }}
                                                    className="w-full flex items-center space-x-2 px-3 py-2 text-[11px] font-semibold transition-colors cursor-pointer hover:bg-slate-100"
                                                >
                                                    <Trash2
                                                        size={14}
                                                        className={`shrink-0 ${
                                                            isSelectMode
                                                                ? "text-rose-500"
                                                                : "text-indigo-600"
                                                        }`}
                                                    />
                                                    <span
                                                        className={
                                                            isSelectMode
                                                                ? "text-rose-600"
                                                                : "text-slate-700"
                                                        }
                                                    >
                                                        {isSelectMode
                                                            ? t("Hủy chọn")
                                                            : t("Chọn xóa")}
                                                    </span>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Tab phân loại Module */}
                        <div className="flex border-b border-slate-200 bg-slate-100/50 overflow-x-auto scrollbar-hide">
                            {[
                                {
                                    key: "thung" as const,
                                    label: t("Thùng & Cấu kiện con"),
                                    count: thungCount,
                                },
                                {
                                    key: "ctht" as const,
                                    label: t("CTHT"),
                                    count: cthtCount,
                                },
                                {
                                    key: "lenFiller" as const,
                                    label: t("Len, Filler, Filter"),
                                    count: lenFillerEntries.length,
                                },
                                {
                                    key: "phukien" as const,
                                    label: t("Phụ Kiện"),
                                    count: accessorySummary.length,
                                },
                            ].map((tab) => (
                                <button
                                    key={tab.key}
                                    onClick={() => setModuleTab(tab.key)}
                                    className={`flex-none px-4 sm:px-6 py-3 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all cursor-pointer whitespace-nowrap ${
                                        moduleTab === tab.key
                                            ? "border-indigo-600 text-indigo-600 bg-white"
                                            : "border-transparent text-slate-500 hover:text-slate-800"
                                    }`}
                                >
                                    {tab.label} ({tab.count})
                                </button>
                            ))}
                        </div>

                        {moduleTab === "phukien" ? (
                            <div className="p-4 space-y-4">
                                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center">
                                        <Boxes
                                            size={14}
                                            className="mr-1.5 text-orange-500"
                                        />
                                        {t("Tổng hợp Phụ Kiện công trình")} (
                                        {accessorySummary.length})
                                    </p>
                                    <div className="flex items-center gap-2">
                                        {roles &&
                                            roles.some(
                                                (r) =>
                                                    r !== "viewer" &&
                                                    r !== "pending",
                                            ) && (
                                                <button
                                                    onClick={() =>
                                                        setShowExportProposalModal(
                                                            true,
                                                        )
                                                    }
                                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-55 hover:bg-orange-100 text-orange-600 rounded-lg border border-orange-100 transition-all text-[9px] font-black uppercase tracking-widest cursor-pointer shadow-sm"
                                                    title={t(
                                                        "Đề nghị xuất hàng phụ kiện",
                                                    )}
                                                >
                                                    <ClipboardCheck size={12} />
                                                    <span>
                                                        {t("Đề nghị xuất")}
                                                    </span>
                                                </button>
                                            )}
                                        {isAdmin && (
                                            <button
                                                onClick={() =>
                                                    setShowAddAccModal(true)
                                                }
                                                className="p-1.5 bg-orange-55 hover:bg-orange-100 text-orange-600 rounded-lg border border-orange-100 transition-all flex items-center justify-center cursor-pointer shadow-sm"
                                                title={t("Thêm phụ kiện mới")}
                                            >
                                                <Plus size={14} />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <div className="overflow-x-auto scrollbar-hide">
                                    <table className="hidden md:table w-full text-left border-collapse table-fixed min-w-[500px]">
                                        <thead className="sticky top-0 z-10 bg-slate-100 text-slate-400 text-[10px] font-black uppercase tracking-[0.15em] border-b border-slate-200">
                                            <tr>
                                                <th className="pl-6 py-4 w-12 text-center">
                                                    #
                                                </th>
                                                <th className="py-4 pl-2">
                                                    {t("Tên Phụ Kiện")}
                                                </th>
                                                <th className="py-4 w-36 text-center">
                                                    {t("Trạng thái")}
                                                </th>
                                                <th className="py-4 w-32 text-center">
                                                    {t("Đã Xuất / Tổng")}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                            {accessorySummary.length > 0 ? (
                                                accessorySummary.map(
                                                    (
                                                        [name, data]: [
                                                            any,
                                                            any,
                                                        ],
                                                        idx,
                                                    ) => {
                                                        const isComplete =
                                                            data.issued >=
                                                                data.total &&
                                                            data.total > 0;
                                                        return (
                                                            <tr
                                                                key={name}
                                                                onClick={() => {
                                                                    if (isAdmin)
                                                                        setSelectedAccForUpdate(
                                                                            {
                                                                                name,
                                                                                total: data.total,
                                                                                issued: data.issued,
                                                                                status: data.status,
                                                                            },
                                                                        );
                                                                }}
                                                                className={`hover:bg-slate-100 transition-colors group ${isAdmin ? "cursor-pointer" : "cursor-default"}`}
                                                            >
                                                                <td className="pl-6 py-4 text-[10px] font-black text-slate-300 text-center">
                                                                    {idx + 1}
                                                                </td>
                                                                <td className="py-4 pl-2">
                                                                    <span className="text-xs font-black text-slate-800 leading-tight block truncate uppercase font-mono">
                                                                        {name}
                                                                    </span>
                                                                </td>
                                                                <td className="py-4 text-center">
                                                                    {data.status &&
                                                                    data.status !==
                                                                        "Chưa xuất kho" ? (
                                                                        <span className="text-[8px] font-black uppercase tracking-widest text-slate-500 bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200">
                                                                            {
                                                                                data.status
                                                                            }
                                                                        </span>
                                                                    ) : (
                                                                        <span className="text-[8px] font-black uppercase tracking-widest text-rose-550 bg-rose-105 px-2 py-0.5 rounded-lg border border-rose-200">
                                                                            {t(
                                                                                "Chưa xuất kho",
                                                                            )}
                                                                        </span>
                                                                    )}
                                                                </td>
                                                                <td className="py-4 text-center">
                                                                    <span
                                                                        className={`text-[10px] font-black px-2 py-1 rounded-lg border leading-normal ${isComplete ? "bg-blue-105 text-blue-600 border-blue-200" : "bg-slate-100 text-slate-500 border-slate-200"}`}
                                                                    >
                                                                        {
                                                                            data.issued
                                                                        }{" "}
                                                                        /{" "}
                                                                        {
                                                                            data.total
                                                                        }
                                                                    </span>
                                                                </td>
                                                            </tr>
                                                        );
                                                    },
                                                )
                                            ) : (
                                                <tr>
                                                    <td
                                                        colSpan={4}
                                                        className="px-6 py-12 text-center text-slate-400 text-xs bg-slate-100/20 italic opacity-100 uppercase tracking-widest font-black leading-normal"
                                                    >
                                                        {t(
                                                            "Không có phụ kiện nào trong dự án",
                                                        )}
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>

                                    {/* Mobile List View */}
                                    <div className="md:hidden divide-y divide-slate-100 p-2 space-y-2">
                                        {accessorySummary.length > 0 ? (
                                            accessorySummary.map(
                                                (
                                                    [name, data]: [any, any],
                                                    idx,
                                                ) => {
                                                    const isComplete =
                                                        data.issued >=
                                                            data.total &&
                                                        data.total > 0;
                                                    return (
                                                        <div
                                                            key={name}
                                                            onClick={() => {
                                                                if (isAdmin)
                                                                    setSelectedAccForUpdate(
                                                                        {
                                                                            name,
                                                                            total: data.total,
                                                                            issued: data.issued,
                                                                            status: data.status,
                                                                        },
                                                                    );
                                                            }}
                                                            className="p-3 bg-slate-100/50 rounded-lg border border-slate-200/50 flex flex-col gap-2 transition-colors active:bg-slate-100"
                                                        >
                                                            <div className="flex items-start justify-between gap-2">
                                                                <span className="text-xs font-black text-slate-800 uppercase break-all font-mono">
                                                                    {name}
                                                                </span>
                                                                <span
                                                                    className={`text-[10px] font-black px-2 py-0.5 rounded-lg border leading-normal shrink-0 ${isComplete ? "bg-blue-100 text-blue-600 border-blue-100" : "bg-slate-100 text-slate-500 border-slate-200"}`}
                                                                >
                                                                    {
                                                                        data.issued
                                                                    }
                                                                    /
                                                                    {data.total}
                                                                </span>
                                                            </div>
                                                            <div className="flex items-center justify-between border-t border-dashed border-slate-100 pt-2">
                                                                <span className="text-[8px] font-black text-slate-400 uppercase tracking-wider">
                                                                    {t("Trạng thái")}
                                                                </span>
                                                                {data.status &&
                                                                data.status !==
                                                                    "Chưa xuất kho" ? (
                                                                    <span className="text-[8px] font-black uppercase tracking-widest text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-lg border border-slate-200">
                                                                        {
                                                                            data.status
                                                                        }
                                                                    </span>
                                                                ) : (
                                                                    <span className="text-[8px] font-black uppercase tracking-widest text-rose-500 bg-rose-100/50 px-1.5 py-0.5 rounded-lg border border-rose-200">
                                                                        {t(
                                                                            "Chưa xuất kho",
                                                                        )}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                },
                                            )
                                        ) : (
                                            <div className="px-4 py-8 text-center text-slate-400 text-[10px] bg-slate-100/20 italic rounded-lg">
                                                {t("Không có phụ kiện")}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="overflow-x-auto scrollbar-hide">
                                {/* Desktop Table View */}
                                <table className="hidden md:table w-full text-left border-collapse table-fixed min-w-[500px]">
                                    <thead className="sticky top-0 z-10 bg-slate-100 text-slate-400 text-[10px] font-black uppercase tracking-[0.15em] border-b border-slate-200">
                                        <tr>
                                            {isSelectMode && (
                                                <th className="w-12 py-4 text-center"></th>
                                            )}
                                            <th className="w-12 pl-4 py-4 text-center">
                                                #
                                            </th>
                                            <th className="w-24 py-4">
                                                {t("Cụm")}
                                            </th>
                                            <th className="py-4 w-76">
                                                Mã Module
                                            </th>
                                            <th className="w-24 py-4 text-center">
                                                {t("Nhận X2")}
                                            </th>
                                            <th className="w-20 py-4 text-center">
                                                {t("SL")}
                                            </th>
                                            <th className="py-4 w-32 text-center">
                                                {t("QC Pass")}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                        {entries.map((entry, idx) => {
                                            const isSelected =
                                                selectedModuleIds.includes(
                                                    entry.id,
                                                );
                                            const lastStatus = entry.status
                                                ? entry.status
                                                      .split(" - ")
                                                      .pop() || ""
                                                : "";

                                            const entryType =
                                                getEntryType(entry);
                                            const isChild = (entry as any)
                                                .isChild;

                                            return (
                                                <tr
                                                    key={`${entry.id}-${idx}`}
                                                    className={`hover:bg-slate-200 transition-colors cursor-pointer group ${
                                                        isChild
                                                            ? "bg-slate-100/10"
                                                            : ""
                                                    } ${isSelected ? "bg-indigo-100/30" : ""} ${selectedModuleDetail?.id === entry.id ? "bg-indigo-100 border-l-2 border-l-indigo-500" : ""}`}
                                                    onClick={() =>
                                                        handleRowClick(entry)
                                                    }
                                                >
                                                    {isSelectMode && (
                                                        <td className="py-2 text-center">
                                                            <div
                                                                className={`w-5 h-5 mx-auto rounded-lg border flex items-center justify-center transition-all ${isSelected ? "bg-indigo-600 border-indigo-600" : "border-slate-200 bg-white"}`}
                                                            >
                                                                {isSelected && (
                                                                    <Check
                                                                        size={
                                                                            12
                                                                        }
                                                                        className="text-white"
                                                                    />
                                                                )}
                                                            </div>
                                                        </td>
                                                    )}
                                                    <td className="pl-4 py-1 text-[10px] font-black text-slate-300 text-center">
                                                        {idx + 1}
                                                    </td>
                                                    <td className="py-1">
                                                        <span className="text-[10px] text-slate-400 font-black uppercase truncate block">
                                                            {entry.cluster ||
                                                                "—"}
                                                        </span>
                                                    </td>
                                                    <td className="py-1">
                                                        <div className="flex items-center gap-3">
                                                            {isChild && (
                                                                <span className="text-slate-300 font-mono select-none text-[11px] ml-3 shrink-0">
                                                                    └──
                                                                </span>
                                                            )}
                                                            <span
                                                                className={`text-sm font-black text-slate-900 uppercase tracking-tight truncate ${isChild ? "text-[13px] text-slate-500 font-medium" : ""}`}
                                                                title={
                                                                    entry.displayName
                                                                        ? entry.moduleCode
                                                                        : undefined
                                                                }
                                                            >
                                                                {" "}
                                                                {
                                                                    entry.displayName ||
                                                                        entry.moduleCode
                                                                }{" "}
                                                            </span>
                                                            <span
                                                                className={`text-[7px] font-black px-1.5 py-0.5 rounded-lg border whitespace-nowrap uppercase tracking-widest ${
                                                                    entryType ===
                                                                        "Thùng" ||
                                                                    entryType ===
                                                                        "Đợt di động"
                                                                        ? "bg-indigo-100/50 text-indigo-600 border-indigo-100"
                                                                        : "bg-amber-100/50 text-amber-600 border-amber-100"
                                                                }`}
                                                            >
                                                                {entryType}
                                                            </span>
                                                        </div>
                                                    </td>
                                                    <td className="py-1 text-center">
                                                        {(() => {
                                                            const recQty =
                                                                entry.receivedQuantity ||
                                                                0;
                                                            const totQty =
                                                                entry.quantity ||
                                                                0;
                                                            let iconColor =
                                                                "text-slate-300";
                                                            let iconTitle =
                                                                t("Chưa nhận");

                                                            if (
                                                                recQty > 0 &&
                                                                recQty < totQty
                                                            ) {
                                                                iconColor =
                                                                    "text-amber-500";
                                                                iconTitle =
                                                                    t(
                                                                        "Đang nhận chưa đủ",
                                                                    );
                                                            } else if (
                                                                recQty >=
                                                                    totQty &&
                                                                totQty > 0
                                                            ) {
                                                                iconColor =
                                                                    "text-emerald-500";
                                                                iconTitle =
                                                                    t(
                                                                        "Đã nhận đủ",
                                                                    );
                                                            }
                                                            return (
                                                                <div
                                                                    className="flex items-center justify-center"
                                                                    title={`${iconTitle}: ${recQty}/${totQty}`}
                                                                >
                                                                    <CheckCircle
                                                                        size={
                                                                            18
                                                                        }
                                                                        className={`${iconColor}`}
                                                                    />
                                                                </div>
                                                            );
                                                        })()}
                                                    </td>
                                                    <td className="py-1 text-center text-sm font-black text-slate-900">
                                                        {(entry.receivedQuantity ||
                                                            0) < entry.quantity
                                                            ? `${entry.receivedQuantity || 0}/${entry.quantity}`
                                                            : entry.quantity}
                                                    </td>
                                                    <td className="py-1">
                                                        <div className="flex items-center justify-center gap-1 opacity-[0.95]">
                                                            {[
                                                                {
                                                                    id: "white",
                                                                    label: "T",
                                                                    stage: "white",
                                                                },
                                                                {
                                                                    id: "paint",
                                                                    label: "S",
                                                                    stage: "paint",
                                                                },
                                                                {
                                                                    id: "finish",
                                                                    label: "H",
                                                                    stage: "finish",
                                                                },
                                                                {
                                                                    id: "pack",
                                                                    label: "Đ",
                                                                    stage: "pack",
                                                                },
                                                            ].map((s, idx) => {
                                                                const qcData =
                                                                    getModuleQcAggregate(
                                                                        entry,
                                                                        s.stage as any,
                                                                    );
                                                                const inTicket =
                                                                    isModuleInTicket(
                                                                        entry.id,
                                                                        entry.moduleCode,
                                                                        s.stage,
                                                                    );
                                                                const effectiveStatus =
                                                                    qcData?.status ||
                                                                    (inTicket
                                                                        ? "pending"
                                                                        : "none");
                                                                return (
                                                                    <div
                                                                        key={
                                                                            idx
                                                                        }
                                                                        className={`w-6 h-6 rounded-lg flex items-center justify-center border transition-all ${
                                                                            effectiveStatus ===
                                                                            "pass"
                                                                                ? "bg-emerald-500 border-emerald-600 text-white shadow-lg shadow-emerald-500/20"
                                                                                : effectiveStatus ===
                                                                                    "pending"
                                                                                  ? "bg-amber-500 border-amber-600 text-white shadow-lg shadow-amber-500/20"
                                                                                  : effectiveStatus ===
                                                                                      "fail"
                                                                                    ? "bg-red-500 border-red-600 text-white shadow-lg shadow-red-500/20"
                                                                                    : "bg-slate-100 border-slate-100 text-slate-300 font-bold"
                                                                        }`}
                                                                        title={`QC ${s.label}`}
                                                                    >
                                                                        <span className="text-[10px] font-black leading-none">
                                                                            {
                                                                                s.label
                                                                            }
                                                                        </span>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>

                                {/* Mobile Card View */}
                                <div className="md:hidden divide-y divide-slate-100">
                                    {entries.map((entry, idx) => {
                                        const isSelected =
                                            selectedModuleIds.includes(
                                                entry.id,
                                            );
                                        const lastStatus = entry.status
                                            ? entry.status.split(" - ").pop() ||
                                              ""
                                            : "";

                                        const entryType = getEntryType(entry);
                                        const isChild = (entry as any).isChild;

                                        return (
                                            <div
                                                key={`${entry.id}-${idx}`}
                                                onClick={() =>
                                                    handleRowClick(entry)
                                                }
                                                className={`p-2.5 flex items-center justify-between gap-2 transition-colors active:bg-slate-100 ${
                                                    isChild
                                                        ? "pl-6 bg-slate-100/10"
                                                        : ""
                                                } ${isSelected ? "bg-indigo-100/50" : ""}`}
                                            >
                                                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                                    {isChild && (
                                                        <span className="text-slate-300 font-mono select-none text-xs shrink-0">
                                                            └─
                                                        </span>
                                                    )}
                                                    <span
                                                        className={`text-[8px] font-black px-1.5 py-0.2 rounded-md border uppercase tracking-widest leading-normal shrink-0 ${
                                                            entryType ===
                                                                "Thùng" ||
                                                            entryType ===
                                                                "Đợt di động"
                                                                ? "bg-indigo-100 text-indigo-600 border-indigo-100"
                                                                : "bg-amber-100 text-amber-600 border-amber-100"
                                                        }`}
                                                    >
                                                        {entryType === "Thùng"
                                                            ? "T"
                                                            : entryType ===
                                                                "Đợt di động"
                                                              ? "Đ"
                                                              : entryType ===
                                                                  "Cánh"
                                                                ? "C"
                                                                : entryType ===
                                                                    "Mặt HK"
                                                                  ? "M"
                                                                  : "K"}
                                                    </span>
                                                    {entry.cluster && (
                                                        <span
                                                            className="text-[7px] font-black px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 uppercase tracking-wider shrink-0 max-w-[64px] truncate border border-slate-200/60 leading-normal"
                                                            title={entry.cluster}
                                                        >
                                                            {entry.cluster}
                                                        </span>
                                                    )}
                                                    <span
                                                        className={`text-[12px] font-black text-slate-900 uppercase truncate ${isChild ? "font-medium text-slate-500" : ""}`}
                                                        title={entry.displayName ? entry.moduleCode : undefined}
                                                    >
                                                        {entry.displayName || entry.moduleCode}
                                                    </span>
                                                    {(() => {
                                                        const recQty =
                                                            entry.receivedQuantity ||
                                                            0;
                                                        const totQty =
                                                            entry.quantity || 0;
                                                        let iconColor =
                                                            "text-slate-300";
                                                        if (
                                                            recQty > 0 &&
                                                            recQty < totQty
                                                        ) {
                                                            iconColor =
                                                                "text-amber-500";
                                                        } else if (
                                                            recQty >= totQty &&
                                                            totQty > 0
                                                        ) {
                                                            iconColor =
                                                                "text-emerald-500";
                                                        }
                                                        return (
                                                            <CheckCircle
                                                                size={13}
                                                                className={`${iconColor} shrink-0`}
                                                            />
                                                        );
                                                    })()}
                                                </div>

                                                <div className="flex items-center gap-2 shrink-0">
                                                    {/* Thông tin phụ gom lại phía sau một hàng dọc/ngang cực nhỏ gọn */}
                                                    <span className="text-[11px] font-black text-slate-600 shrink-0">
                                                        {(entry.receivedQuantity ||
                                                            0) < entry.quantity
                                                            ? `x${entry.receivedQuantity || 0}/${entry.quantity}`
                                                            : `x${entry.quantity}`}
                                                    </span>

                                                    <span className="flex items-center gap-0.5 shrink-0">
                                                        {[
                                                            {
                                                                id: "white",
                                                                label: "T",
                                                                stage: "white",
                                                            },
                                                            {
                                                                id: "paint",
                                                                label: "S",
                                                                stage: "paint",
                                                            },
                                                            {
                                                                id: "finish",
                                                                label: "H",
                                                                stage: "finish",
                                                            },
                                                            {
                                                                id: "pack",
                                                                label: "Đ",
                                                                stage: "pack",
                                                            },
                                                        ].map((s, idx) => {
                                                            const qcData =
                                                                getModuleQcAggregate(
                                                                    entry,
                                                                    s.stage as any,
                                                                );
                                                            const inTicket =
                                                                isModuleInTicket(
                                                                    entry.id,
                                                                    entry.moduleCode,
                                                                    s.stage,
                                                                );
                                                            const effectiveStatus =
                                                                qcData?.status ||
                                                                (inTicket
                                                                    ? "pending"
                                                                    : "none");
                                                            return (
                                                                <span
                                                                    key={idx}
                                                                    className={`w-3 h-3 rounded-full flex items-center justify-center border transition-all ${
                                                                        effectiveStatus ===
                                                                        "pass"
                                                                            ? "bg-emerald-500 border-emerald-600 shadow-lg shadow-emerald-500/20"
                                                                            : effectiveStatus ===
                                                                                "pending"
                                                                              ? "bg-amber-500 border-amber-600 shadow-lg shadow-amber-500/20"
                                                                              : effectiveStatus ===
                                                                                  "fail"
                                                                                ? "bg-red-500 border-red-700 shadow-lg shadow-red-500/20"
                                                                                : "bg-slate-100 border-slate-100 text-slate-300 font-bold"
                                                                    }`}
                                                                ></span>
                                                            );
                                                        })}
                                                    </span>
                                                    <ChevronRight
                                                        size={14}
                                                        className="text-slate-300 shrink-0"
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* RIGHT COLUMN: Chi tiết cấu kiện (always) + Accessories */}<div className="space-y-4 h-fit sticky top-20 lg:col-span-5">
                    
                        {/* Chi tiết cấu kiện - always visible */}
                        <div className="bg-white rounded-lg shadow-none border border-slate-200">
                            <div className="px-4 py-3 bg-indigo-600 text-white flex items-center justify-between">
                                <h3 className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2">
                                    <Cuboid size={14} />
                                    {t("Chi tiết cấu kiện")}
                                </h3>
                                {selectedModuleDetail && (
                                    <>
                                    {isAdmin && (
                                        <button
                                            onClick={() => setShowCustomNamesModal(true)}
                                            className="p-1 hover:bg-white/20 rounded-lg transition-colors cursor-pointer"
                                            title={t("Chỉnh tên hiển thị & tên object 3D")}
                                        >
                                            <Pencil size={14} />
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setShowModuleRawData(true)}
                                        className="p-1 hover:bg-white/20 rounded-lg transition-colors cursor-pointer"
                                        title={t("Xem Raw Data")}
                                    >
                                        <Code size={14} />
                                    </button>
                                    <button
                                        onClick={() =>
                                            setSelectedModuleDetail(null)
                                        }
                                        className="p-1 hover:bg-white/20 rounded-lg transition-colors cursor-pointer"
                                    >
                                        <X size={14} />
                                    </button>
                                    </>
                                )}
                            </div>

                            {selectedModuleDetail ? (
                                <>
                                    {(() => {
                                        const glbUrl =
                                            getModuleGlbUrl(
                                                selectedModuleDetail,
                                            ).trim();
                                        if (!glbUrl) return null;
                                        // ẩn 3D view khi modal mở để tránh WebGL Context Lost
                                        if (showNativeViewer) return null;
                                        return (
                                            <div className="p-4 border-b border-slate-200">
                                                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2">
                                                    {t(
                                                        "Mô hình 3D (CAD ISO View)",
                                                    )}
                                                </p>
                                                <div className="rounded-lg overflow-hidden border border-slate-200/60">
                                                    <ModuleThreeViewer
                                                        url={glbUrl}
                                                        moduleName={
                                                            selectedModuleDetail.objectName ||
                                                            selectedModuleDetail.moduleCode
                                                        }
                                                        cameraAngle={
                                                            selectedModuleDetail.cameraAngle
                                                        }
                                                        onMatchLog={setDetailMatchLogs}
                                                        customFadedKeys={
                                                            (selectedModuleDetail.objectClusterName || '')
                                                                .split(/[\n,]/)
                                                                .map(s => s.trim())
                                                                .filter(Boolean)
                                                        }
                                                        customClearKeys={
                                                            (selectedModuleDetail.objectName || '')
                                                                .split(/[\n,]/)
                                                                .map(s => s.trim())
                                                                .filter(Boolean)
                                                        }
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })()}

                                    <div className="px-4 py-3 space-y-2">
                                        <div className="flex items-center gap-2 px-2 py-1.5 bg-slate-100 rounded-lg">
                                            <span className="text-[7px] font-black text-slate-400 uppercase tracking-widest shrink-0">
                                                {t("Mã")}
                                            </span>
                                            <span className="text-[11px] font-black text-slate-900 font-mono break-all uppercase">
                                                {
                                                    selectedModuleDetail.moduleCode
                                                }
                                            </span>
                                        </div>
                                        {(() => {
                                            const _s = selectedModuleDetail;
                                            const field = (
                                                label: string,
                                                value: React.ReactNode,
                                                cls?: string,
                                            ) => (
                                                <span
                                                    className="truncate"
                                                    title={String(value)}
                                                >
                                                    <span className="text-[7px] font-black text-slate-400 uppercase tracking-widest">
                                                        {label}
                                                    </span>
                                                    <span
                                                        className={`text-[10px] font-black ml-1 ${cls || "text-slate-800"}`}
                                                    >
                                                        {value}
                                                    </span>
                                                </span>
                                            );
                                            return (
                                                <>
                                                    <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                                                        <div className="bg-slate-100 rounded-lg px-2 py-1.5">
                                                            {field(
                                                                t("Cụm"),
                                                                _s.cluster ||
                                                                    "—",
                                                            )}
                                                        </div>
                                                        <div className="bg-slate-100 rounded-lg px-2 py-1.5">
                                                            {field(
                                                                t("Loại"),
                                                                getEntryType(
                                                                    _s,
                                                                ),
                                                            )}
                                                        </div>
                                                        <div className="bg-slate-100 rounded-lg px-2 py-1.5">
                                                            {field(
                                                                t("SL"),
                                                                _s.quantity ||
                                                                    1,
                                                            )}
                                                        </div>
                                                        <div className="bg-slate-100 rounded-lg px-2 py-1.5">
                                                            {field(
                                                                t("Nhận"),
                                                                <span
                                                                    className={
                                                                        (_s.receivedQuantity ||
                                                                            0) >=
                                                                        (_s.quantity ||
                                                                            0)
                                                                            ? "text-emerald-600"
                                                                            : "text-rose-500"
                                                                    }
                                                                >
                                                                    {_s.receivedQuantity ||
                                                                        0}
                                                                    /
                                                                    {_s.quantity ||
                                                                        1}
                                                                </span>,
                                                            )}
                                                        </div>
                                                        {_s.width !== 0 && _s.depth !== 0 && _s.height !== 0 && _s.pWidth !== 0 && _s.pDepth !== 0 && _s.pHeight !== 0 && (
                                                        <div className="bg-slate-100 rounded-lg px-2 py-1.5 col-span-2">
                                                            {field(
                                                                t("D×R×C"),
                                                                `${_s.pWidth ?? _s.width ?? 0}×${_s.pDepth ?? _s.depth ?? 0}×${_s.pHeight ?? _s.height ?? 0}`,
                                                                "text-slate-700 font-mono",
                                                            )}
                                                        </div>
                                                        )}
                                                        {_s.material && (
                                                            <div className="bg-slate-100 rounded-lg px-2 py-1.5 col-span-3">
                                                                {field(
                                                                    t(
                                                                        "Vật liệu",
                                                                    ),
                                                                    _s.material,
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                </>
                                            );
                                        })()}

                                        {(() => {
                                            const _s = selectedModuleDetail;
                                            const instances = getModuleInstances(_s);
                                            const allPhotos: { url: string; label: string; instIdx: number }[] = [];
                                            const seenUrls = new Set<string>();
                                            const addPhoto = (url: string, label: string, instIdx: number) => {
                                                if (url && !seenUrls.has(url)) {
                                                    seenUrls.add(url);
                                                    allPhotos.push({ url, label, instIdx });
                                                }
                                            };

                                            // QC photos from each instance
                                            const qcStages = [
                                                { field: "qcWhite", short: t("Trắng") },
                                                { field: "qcPaint", short: t("Sơn") },
                                                { field: "qcFinish", short: "HT" },
                                                { field: "qcPack", short: t("Gói") },
                                            ];
                                            instances.forEach((inst) => {
                                                const idx = (inst as any).instanceIndex || 0;
                                                qcStages.forEach(({ field, short }) => {
                                                    const qcData = (inst as any)[field];
                                                    if (qcData && qcData.status !== "fail" && qcData.photos?.length) {
                                                        qcData.photos.forEach((p: string) => addPhoto(p, `#${idx} - QC ${short}`, idx));
                                                    }
                                                });
                                            });

                                            // Module-level QC photos fallback
                                            if (allPhotos.filter(p => p.label.startsWith("QC")).length === 0) {
                                                qcStages.forEach(({ field, short }) => {
                                                    const data = getModuleQcAggregate(_s, field.replace("qc", "").toLowerCase() as any);
                                                    if (data && data.status !== "fail" && data.photos?.length) {
                                                        data.photos.forEach((p) => addPhoto(p, `QC ${short}`, 0));
                                                    }
                                                });
                                            }

                                            // Packing photos
                                            if (detailPackingPhotos.length) {
                                                detailPackingPhotos.forEach((p) => {
                                                    const idx = p.instanceIndex ?? 0;
                                                    addPhoto(p.url, `#${idx} - Đóng gói`, idx);
                                                });
                                            }

                                            if (!allPhotos.length) return null;
                                            const urls = allPhotos.map((p) => p.url);
                                            return (
                                                <div className="pt-2 border-t border-slate-200">
                                                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1.5 flex items-center">
                                                        <ImageIcon
                                                            size={10}
                                                            className="mr-1"
                                                        />{" "}
                                                        {t("Ảnh")} (
                                                        {allPhotos.length})
                                                    </p>
                                                    <div className="grid grid-cols-6 gap-1.5">
                                                        {allPhotos.map(
                                                            (img, i) => (
                                                                <button
                                                                    key={i}
                                                                    type="button"
                                                                    className="relative rounded-lg overflow-hidden border border-slate-200 focus:outline-none block w-full cursor-pointer"
                                                                    onClick={() => {
                                                                        setLightboxImages(
                                                                            urls,
                                                                        );
                                                                        setLightboxStartIndex(
                                                                            i,
                                                                        );
                                                                        (
                                                                            document.getElementById(
                                                                                "photo-dialog",
                                                                            ) as HTMLDialogElement
                                                                        )?.showModal();
                                                                    }}
                                                                >
                                                                    <img
                                                                        src={
                                                                            img.url
                                                                        }
                                                                        alt={
                                                                            img.label
                                                                        }
                                                                        className="w-full h-16 object-cover"
                                                                        loading="lazy"
                                                                        onError={(
                                                                            e,
                                                                        ) => {
                                                                            (
                                                                                e.target as HTMLImageElement
                                                                            ).style.display =
                                                                                "none";
                                                                        }}
                                                                    />
                                                                    <span className="absolute bottom-0 left-0 right-0 text-[7px] font-bold text-white bg-black/60 text-center py-0.5 uppercase">
                                                                        {
                                                                            img.label
                                                                        }
                                                                    </span>
                                                                </button>
                                                            ),
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })()}

                                        {(() => {
                                            const _s = selectedModuleDetail;
                                            const instances =
                                                getModuleInstances(_s);
                                            if (instances.length === 0)
                                                return null;
                                            const stageFields = [
                                                {
                                                    field: "qcWhite",
                                                    short: "T",
                                                },
                                                {
                                                    field: "qcPaint",
                                                    short: "S",
                                                },
                                                {
                                                    field: "qcFinish",
                                                    short: "H",
                                                },
                                                { field: "qcPack", short: "Đ" },
                                            ];
                                            return (
                                                <div className="pt-2 border-t border-slate-200">
                                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                                                        {t("QC từng kiện")} (
                                                        {instances.length})
                                                    </p>
                                                    <div className="overflow-x-auto border border-slate-200 rounded-lg">
                                                        <table className="w-full text-center min-w-[280px]">
                                                            <thead>
                                                                <tr className="bg-slate-100 border-b border-slate-200">
                                                                    <th className="px-1.5 py-1 text-[10px] font-black text-slate-500 uppercase tracking-wider text-left">
                                                                        {t(
                                                                            "Kiện",
                                                                        )}
                                                                    </th>
                                                                    {stageFields.map(
                                                                        (s) => (
                                                                            <th
                                                                                key={
                                                                                    s.field
                                                                                }
                                                                                className="px-1.5 py-1 text-[10px] font-black text-slate-500 uppercase tracking-wider"
                                                                            >
                                                                                {
                                                                                    s.short
                                                                                }
                                                                            </th>
                                                                        ),
                                                                    )}
                                                                </tr>
                                                            </thead>
                                                            <tbody className="divide-y divide-slate-100">
                                                                {instances.map(
                                                                    (inst) => {
                                                                        const recQty =
                                                                            _s.receivedQuantity ||
                                                                            0;
                                                                        const isDelivered =
                                                                            recQty >=
                                                                            (inst.instanceIndex ||
                                                                                0);
                                                                        return (
                                                                            <tr
                                                                                key={
                                                                                    inst.instanceIndex
                                                                                }
                                                                                className={`${isDelivered ? "bg-emerald-100/30" : "bg-white"} hover:bg-indigo-100/30 transition-colors`}
                                                                            >
                                                                                <td className="px-1.5 py-1 text-left">
                                                                                    <span className="text-[9px] font-black text-slate-700">
                                                                                        #
                                                                                        {
                                                                                            inst.instanceIndex
                                                                                        }
                                                                                    </span>
                                                                                    <span
                                                                                        className={`ml-1 text-[6px] font-bold px-1 py-0.5 rounded-sm ${isDelivered ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-400"}`}
                                                                                    >
                                                                                        {isDelivered
                                                                                            ? t(
                                                                                                  "Đã nhận",
                                                                                              )
                                                                                            : t(
                                                                                                  "Chưa nhận",
                                                                                              )}
                                                                                    </span>
                                                                                </td>
                                                                                {stageFields.map(
                                                                                    (
                                                                                        s,
                                                                                    ) => {
                                                                                        const qcData =
                                                                                            (
                                                                                                inst as any
                                                                                            )[
                                                                                                s
                                                                                                    .field
                                                                                            ];
                                                                                        const status =
                                                                                            qcData?.status ||
                                                                                            "none";
                                                                                        const bg =
                                                                                            status ===
                                                                                            "pass"
                                                                                                ? "bg-emerald-100 text-emerald-700"
                                                                                                : status ===
                                                                                                    "fail"
                                                                                                  ? "bg-rose-100 text-rose-700"
                                                                                                  : status ===
                                                                                                      "pending"
                                                                                                    ? "bg-amber-100 text-amber-700"
                                                                                                    : "bg-slate-50 text-slate-400";
                                                                                        const label =
                                                                                            status ===
                                                                                            "pass"
                                                                                                ? "✓"
                                                                                                : status ===
                                                                                                    "fail"
                                                                                                  ? "✗"
                                                                                                  : status ===
                                                                                                      "pending"
                                                                                                    ? "…"
                                                                                                    : "—";
                                                                                        return (
                                                                                            <td
                                                                                                key={
                                                                                                    s.field
                                                                                                }
                                                                                                className="px-1.5 py-1"
                                                                                            >
                                                                                                <span
                                                                                                    className={`inline-flex items-center justify-center w-5 h-5 rounded text-[8px] font-black ${bg}`}
                                                                                                    title={
                                                                                                        qcData?.by
                                                                                                            ? `${status.toUpperCase()} by ${qcData.by}`
                                                                                                            : status
                                                                                                    }
                                                                                                >
                                                                                                    {
                                                                                                        label
                                                                                                    }
                                                                                                </span>
                                                                                            </td>
                                                                                        );
                                                                                    },
                                                                                )}
                                                                            </tr>
                                                                        );
                                                                    },
                                                                )}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                </div>
                                            );
                                        })()}
                                        {selectedModuleDetail.accessories &&
                                            selectedModuleDetail.accessories
                                                .length > 0 && (
                                                <div className="pt-2 border-t border-slate-200">
                                                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1.5 flex items-center">
                                                        <Package
                                                            size={10}
                                                            className="mr-1"
                                                        />{" "}
                                                        {t("Vật tư phụ")} (
                                                        {
                                                            selectedModuleDetail
                                                                .accessories
                                                                .length
                                                        }
                                                        )
                                                    </p>
                                                    <div className="space-y-1 max-h-[160px] overflow-y-auto pr-1 custom-scrollbar">
                                                        {selectedModuleDetail.accessories.map(
                                                            (
                                                                acc: any,
                                                                i: number,
                                                            ) => (
                                                                <div
                                                                    key={i}
                                                                    className="flex items-center justify-between px-2 py-1 bg-slate-100 rounded-lg"
                                                                >
                                                                    <span
                                                                        className="text-[10px] font-bold text-slate-700 truncate max-w-[140px]"
                                                                        title={
                                                                            acc.name
                                                                        }
                                                                    >
                                                                        {
                                                                            acc.name
                                                                        }
                                                                    </span>
                                                                    <div className="flex items-center gap-2">
                                                                        <span className="text-[10px] font-mono font-black text-indigo-600">
                                                                            {
                                                                                acc.quantity
                                                                            }
                                                                        </span>
                                                                        {acc.issuedQuantity >
                                                                            0 && (
                                                                            <span className="text-[8px] font-bold text-emerald-500">
                                                                                ✓{" "}
                                                                                {
                                                                                    acc.issuedQuantity
                                                                                }
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            ),
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        {/* {selectedModuleDetail.statusHistory &&
                                            selectedModuleDetail.statusHistory
                                                .length > 0 && (
                                                <div className="pt-2 border-t border-slate-200">
                                                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1.5 flex items-center">
                                                        <History
                                                            size={10}
                                                            className="mr-1"
                                                        />{" "}
                                                        {t("Nhật ký")}
                                                    </p>
                                                    <div className="space-y-1.5 max-h-[120px] overflow-y-auto pr-1 custom-scrollbar">
                                                        {selectedModuleDetail.statusHistory
                                                            .slice()
                                                            .reverse()
                                                            .slice(0, 5)
                                                            .map((h, i) => {
                                                                const p =
                                                                    h.split(
                                                                        "|",
                                                                    );
                                                                const ts = p[1]
                                                                    ? Number(
                                                                          p[1],
                                                                      )
                                                                    : null;
                                                                return (
                                                                    <div
                                                                        key={i}
                                                                        className="flex items-start gap-1.5"
                                                                    >
                                                                        <span
                                                                            className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${(p[0] || "").toLowerCase().includes("pass") || (p[0] || "").toLowerCase().includes("đạt") ? "bg-emerald-500" : (p[0] || "").toLowerCase().includes("fail") ? "bg-rose-500" : "bg-slate-300"}`}
                                                                        />
                                                                        <div>
                                                                            <p className="text-[8px] font-bold text-slate-700 uppercase leading-tight">
                                                                                {
                                                                                    p[0]
                                                                                }
                                                                            </p>
                                                                            <p className="text-[7px] text-slate-400 font-mono">
                                                                                {ts
                                                                                    ? new Date(
                                                                                          ts,
                                                                                      ).toLocaleString(
                                                                                          "vi-VN",
                                                                                          {
                                                                                              day: "2-digit",
                                                                                              month: "2-digit",
                                                                                              hour: "2-digit",
                                                                                              minute: "2-digit",
                                                                                          },
                                                                                      )
                                                                                    : ""}
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                    </div>
                                                </div>
                                            )} */}
                                    </div>
                                </>
                            ) : (
                                <div className="p-8 flex flex-col items-center justify-center text-center">
                                    <Cuboid
                                        size={32}
                                        className="text-slate-200 mb-2"
                                    />
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                        {t("Chọn cấu kiện")}
                                    </p>
                                    <p className="text-[9px] text-slate-300 mt-0.5">
                                        {t("bên trái để xem thông tin")}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Floating Bulk Actions for Mobile only or sticky for PC */}
                {isSelectMode && selectedModuleIds.length > 0 && (
                    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 lg:bottom-10 lg:translate-x-0 lg:left-auto lg:right-10 z-100 flex items-center gap-3 bg-white p-2 rounded-full border border-slate-200 shadow-2xl">
                        <motion.button
                            initial={{ y: 20, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            onClick={() => setShowBulkModal(true)}
                            className="bg-[#28a745] hover:bg-[#218838] text-white px-5 py-2.5 rounded-full flex items-center space-x-2 font-black uppercase tracking-widest text-[9px] transition-all"
                        >
                            <Save size={14} />
                            <span>
                                {t("Cập nhật")} ({selectedModuleIds.length})
                            </span>
                        </motion.button>
                        {isAdmin && (
                            <motion.button
                                initial={{ y: 20, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                onClick={() => setShowBulkDeleteConfirm(true)}
                                className="bg-rose-600 hover:bg-rose-700 text-white px-5 py-2.5 rounded-full flex items-center space-x-2 font-black uppercase tracking-widest text-[9px] transition-all"
                            >
                                <Trash2 size={14} />
                                <span>
                                    {t("Xóa")} ({selectedModuleIds.length})
                                </span>
                            </motion.button>
                        )}
                    </div>
                )}

                {showDeleteModal && (
                    <DeleteConfirmationModal
                        projectCode={selectedProject}
                        onConfirm={handleDeleteProject}
                        onClose={() => setShowDeleteModal(false)}
                    />
                )}
                {showBulkDeleteConfirm && (
                    <BulkDeleteConfirmationModal
                        count={selectedModuleIds.length}
                        onConfirm={handleBulkDeleteModules}
                        onClose={() => setShowBulkDeleteConfirm(false)}
                    />
                )}
                {showBulkModal && (
                    <StatusUpdateModal
                        onClose={() => {
                            setShowBulkModal(false);
                            setSelectedModuleIds([]);
                            setIsSelectMode(false);
                        }}
                        entries={entries}
                        preSelectedIds={selectedModuleIds}
                    />
                )}
                {currentModule && (
                    <ModuleDetailModal
                        key={selectedModuleId}
                        module={currentModule}
                        onClose={() => setSelectedModuleId(null)}
                        projectAccessories={projectAccessories}
                        allEntries={rawEntries}
                        onOpenModule={(m) => setSelectedModuleId(m.id)}
                    />
                )}
                {selectedAccForUpdate && (
                    <AccessoryUpdateModal
                        accessoryName={selectedAccForUpdate.name}
                        totalRequired={selectedAccForUpdate.total}
                        currentIssued={selectedAccForUpdate.issued}
                        currentStatus={selectedAccForUpdate.status}
                        projectCode={selectedProject}
                        onClose={() => setSelectedAccForUpdate(null)}
                    />
                )}
                {showAddAccModal && (
                    <AddProjectAccessoryModal
                        projectCode={selectedProject}
                        projectEntries={projectEntries}
                        onClose={() => setShowAddAccModal(false)}
                    />
                )}
                {showExportProposalModal && (
                    <ExportProposalModal
                        isOpen={showExportProposalModal}
                        onClose={() => setShowExportProposalModal(false)}
                        projectCode={selectedProject || ""}
                        projectName={
                            projectEntries.find(
                                (p) => p.projectCode === selectedProject,
                            )?.projectName ||
                            selectedProject ||
                            ""
                        }
                        projectEntries={projectEntries}
                        role={role}
                        roles={roles}
                        userProfile={userProfile}
                        onSuccess={(msg) => {
                            setShowExportProposalModal(false);
                            alert(msg);
                        }}
                    />
                )}
                {showDrawingViewer && (
                    <DrawingViewerModal
                        url={showDrawingViewer}
                        onClose={() => setShowDrawingViewer(null)}
                        onEdit={() => {
                            setShowDrawingViewer(null);
                            setShowDrawingEditor(true);
                        }}
                        isAdmin={isPrivileged}
                    />
                )}
                {showDrawingEditor && (
                    <DrawingEditorModal
                        projectCode={selectedProject}
                        projectEntries={rawEntries}
                        onClose={() => setShowDrawingEditor(false)}
                    />
                )}
                {showNativeViewer && (
                    <NativeModelViewerModal
                        url={showNativeViewer.url}
                        drawingUrl={showNativeViewer.drawingUrl}
                        clusters={showNativeViewer.clusters}
                        projectEntries={showNativeViewer.entries}
                        initialViewMode={showNativeViewer.viewMode || "3d"}
                        onClose={() => setShowNativeViewer(null)}
                    />
                )}
                {showNativeEditor && (
                    <NativeModelEditorModal
                        projectCode={selectedProject}
                        projectEntries={rawEntries}
                        onClose={() => setShowNativeEditor(false)}
                    />
                )}
                {showEditProjectInfoModal && (
                    <EditProjectInfoModal
                        projectCode={selectedProject || ""}
                        projectEntries={rawEntries}
                        onClose={() => setShowEditProjectInfoModal(false)}
                        onSaved={() => {
                            // State và Firebase sync tự động cập nhật
                        }}
                    />
                )}
                {showTempLabels && (
                    <TempLabelsModal
                        onClose={() => setShowTempLabels(false)}
                        modules={rawEntries}
                        projectCode={selectedProject}
                    />
                )}
                {showExcelEditorModal && (
                    <ExcelEditorModal
                        projectCode={selectedProject}
                        projectName={rawEntries[0]?.projectName || ""}
                        projectEntries={rawEntries}
                        onClose={() => setShowExcelEditorModal(false)}
                        setProjectEntries={setProjectEntries}
                    />
                )}
                {showReceivedStatusModal && (
                    <ReceivedStatusModal
                        projectCode={selectedProject}
                        projectName={rawEntries[0]?.projectName || ""}
                        projectEntries={rawEntries}
                        type={showReceivedStatusModal}
                        onClose={() => setShowReceivedStatusModal(null)}
                    />
                )}
                {showQuickMergeModal && (
                    <QuickMergeModal
                        projectCode={selectedProject}
                        projectEntries={rawEntries}
                        onClose={() => setShowQuickMergeModal(false)}
                    />
                )}

                {showShelfCheckModal && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            className="bg-white w-full max-w-2xl rounded-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[85vh]"
                        >
                            {/* Modal Header */}
                            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                                <div>
                                    <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">
                                        {t("Check Đợt di động")}
                                    </h3>
                                    <p className="text-[10px] text-sky-500 font-extrabold uppercase mt-0.5">
                                        {t("Dự án:")}
                                        {formatProjectName(
                                            rawEntries[0]?.projectName ||
                                                selectedProject,
                                        )}
                                    </p>
                                </div>
                                <button
                                    onClick={() =>
                                        setShowShelfCheckModal(false)
                                    }
                                    className="p-1 px-1.5 text-slate-400 hover:text-slate-600 rounded-sm hover:bg-slate-100"
                                >
                                    <X size={16} />
                                </button>
                            </div>

                            {/* Informative description */}
                            <div className="bg-sky-100/50 px-5 py-3 border-b border-slate-100 text-[11px] text-slate-600">
                                📌{" "}
                                {t(
                                    "Đánh dấu các đợt di động có đủ số lượng của module thùng tương ứng.",
                                )}{" "}
                                {t("Khi bấm")} <strong>{t("Kiểm xong")}</strong>, {t("những đợt được check sẽ chuyển sang trạng thái")}{" "}
                                <span className="text-blue-600 font-bold">
                                    {t("Đã nhận")}
                                </span>{" "}
                                {t("và ghi nhận đủ số lượng. Đợt không được check sẽ đổi thành trạng thái")}{" "}
                                <span className="text-rose-700 font-bold">
                                    {t("Kiểm lại")}
                                </span>
                                .
                            </div>

                            {/* Scrollable list of cabinets and their shelves */}
                            <div className="flex-1 overflow-y-auto p-5 space-y-3 min-h-[300px] max-h-[50vh]">
                                {thungWithShelves.length === 0 ? (
                                    <div className="py-16 text-center text-slate-400 text-xs">
                                        {t("Không tìm thấy đợt di động nào tương ứng với các module thùng của dự án này.")}
                                    </div>
                                ) : (
                                    thungWithShelves.map(({ thung, shelf }) => {
                                        const isChecked =
                                            !!checkedShelfIds[shelf.id];
                                        return (
                                            <div
                                                key={`${shelf.id}-${thung.id}`}
                                                className={`flex items-center justify-between border p-4 rounded-lg transition-all gap-4 ${
                                                    isChecked
                                                        ? "bg-slate-100/20 border-emerald-500/30"
                                                        : "bg-white border-slate-100"
                                                }`}
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                                                        <span className="text-[9px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-sm font-black uppercase tracking-wider">
                                                            {t("Thùng:")}{" "}
                                                            {thung.moduleCode}
                                                        </span>
                                                        <span className="text-[9px] bg-sky-100 text-sky-600 px-1.5 py-0.5 rounded-sm font-black uppercase tracking-wider">
                                                            {t("Đợt:")}{" "}
                                                            {shelf.moduleCode}
                                                        </span>
                                                        {shelf.status && (
                                                            <span
                                                                className={`text-[8px] px-1.5 py-0.5 rounded-sm font-bold uppercase ${
                                                                    shelf.status.includes(
                                                                        "Đã nhận",
                                                                    )
                                                                        ? "bg-blue-100 text-blue-600"
                                                                        : shelf.status.includes(
                                                                                "Kiểm lại",
                                                                            )
                                                                          ? "bg-rose-100 text-rose-600"
                                                                          : "bg-slate-100 text-slate-500"
                                                                }`}
                                                            >
                                                                {t("Hiện tại:")}{" "}
                                                                {shelf.status
                                                                    .split(
                                                                        " - ",
                                                                    )
                                                                    .pop()}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <h5 className="text-xs font-black text-slate-800 uppercase tracking-tight truncate">
                                                        {t("Số lượng đợt:")}{" "}
                                                        <span className="text-indigo-600 text-sm font-extrabold">
                                                            {shelf.quantity ||
                                                                1}
                                                        </span>
                                                    </h5>
                                                </div>

                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setCheckedShelfIds(
                                                            (prev) => ({
                                                                ...prev,
                                                                [shelf.id]:
                                                                    !prev[
                                                                        shelf.id
                                                                    ],
                                                            }),
                                                        );
                                                    }}
                                                    className={`flex items-center gap-1.5 px-3 py-2 rounded-sm text-[10px] font-black uppercase tracking-wider transition-colors select-none cursor-pointer shrink-0 ${
                                                        isChecked
                                                            ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                                                            : "bg-slate-100 hover:bg-slate-200 text-slate-600"
                                                    }`}
                                                >
                                                    {isChecked ? (
                                                        <>
                                                            <Check
                                                                size={12}
                                                                strokeWidth={3}
                                                            />
                                                            {t("Nhận đủ")}
                                                        </>
                                                    ) : (
                                                        <>
                                                            <div className="w-3 h-3 border-2 border-slate-400 rounded-sm shrink-0" />
                                                            {t("Chưa nhận")}
                                                        </>
                                                    )}
                                                </button>
                                            </div>
                                        );
                                    })
                                )}
                            </div>

                            {/* Modal Footer */}
                            <div className="p-4 bg-slate-100 border-t border-slate-100 flex items-center justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowShelfCheckModal(false)
                                    }
                                    disabled={savingShelfCheck}
                                    className="px-4 py-2.5 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-[10px] font-black uppercase tracking-widest rounded-sm transition-colors active:scale-95 disabled:opacity-100"
                                >
                                    {t("Bỏ qua")}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleShelfCheckComplete}
                                    disabled={savingShelfCheck}
                                    className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-black uppercase tracking-widest rounded-sm transition-colors active:scale-95 shadow-lg shadow-indigo-600/10 flex items-center gap-2 disabled:opacity-100"
                                >
                                    {savingShelfCheck ? (
                                        <>
                                            <Loader2
                                                size={12}
                                                className="animate-spin"
                                            />
                                            {t("Đang xử lý...")}
                                        </>
                                    ) : (
                                        <>
                                            <CheckCircle
                                                size={12}
                                                strokeWidth={2.5}
                                            />
                                            {t("Kiểm xong")}
                                        </>
                                    )}
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}

                {/* Raw Data Modal for Module Detail */}
                {showModuleRawData && selectedModuleDetail && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
                        <div className="bg-white rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl border border-gray-200">
                            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                                <div className="flex items-center gap-2">
                                    <Code size={16} className="text-indigo-600" />
                                    <h3 className="text-sm font-black text-gray-800 uppercase tracking-tight">Raw Data — {selectedModuleDetail.moduleCode}</h3>
                                </div>
                                <button onClick={() => setShowModuleRawData(false)} className="p-1.5 hover:bg-gray-200 rounded-lg transition-all">
                                    <X size={16} className="text-gray-500" />
                                </button>
                            </div>
                            <div className="flex-1 overflow-auto p-4">
                                <pre className="text-[11px] font-mono text-gray-700 whitespace-pre-wrap break-all bg-gray-50 rounded-lg p-4 border border-gray-200">
                                    {JSON.stringify(selectedModuleDetail, null, 2)}
                                </pre>
                            </div>
                            <div className="px-4 py-3 border-t border-gray-200 flex justify-end">
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(JSON.stringify(selectedModuleDetail, null, 2));
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

                {/* MODAL: Chỉnh tên hiển thị & tên object 3D cho module */}
                {showCustomNamesModal && selectedModuleDetail && (
                    <ModuleCustomNamesModal
                        entry={selectedModuleDetail}
                        onClose={() => setShowCustomNamesModal(false)}
                        onSaved={() => {
                            // State tự đồng bộ qua Firestore onSnapshot
                        }}
                        matchLogs={detailMatchLogs}
                    />
                )}

                {/* ===================== MODAL: ẢNH HOÀN THIỆN ===================== */}
                {showAllPhotosModal && (
                    <AllPhotosByClusterModal
                        photosByCluster={photosByCluster}
                        rawEntries={rawEntries}
                        selectedProject={selectedProject || ""}
                        canUpload={canUploadClusterPhotos}
                        onClose={() => setShowAllPhotosModal(false)}
                        onPhotoAdded={() => {
                            // Packing photos are auto-refreshed via onSnapshot
                        }}
                    />
                )}

                <dialog
                    id="photo-dialog"
                    className="m-auto bg-transparent p-0 backdrop:bg-black/90 backdrop:backdrop-blur-md rounded-lg max-w-4xl w-full outline-none"
                    onClick={(e) => {
                        if (e.target === e.currentTarget)
                            (e.target as HTMLDialogElement).close();
                    }}
                >
                    <div className="flex flex-col items-center">
                        <div className="w-full flex items-center justify-between text-white p-2">
                            <span className="text-xs font-black uppercase tracking-wider font-mono">
                                {lightboxStartIndex + 1} /{" "}
                                {lightboxImages.length}
                            </span>
                            <button
                                onClick={() =>
                                    (
                                        document.getElementById(
                                            "photo-dialog",
                                        ) as HTMLDialogElement
                                    )?.close()
                                }
                                className="p-2 hover:bg-white/10 rounded-full transition-all text-gray-300 hover:text-white cursor-pointer"
                            >
                                <X size={24} />
                            </button>
                        </div>
                        <div className="relative w-full flex items-center justify-center p-2">
                            {lightboxImages.length > 1 && (
                                <button
                                    onClick={() =>
                                        setLightboxStartIndex(
                                            (prev) =>
                                                (prev -
                                                    1 +
                                                    lightboxImages.length) %
                                                lightboxImages.length,
                                        )
                                    }
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
                                    onClick={() =>
                                        setLightboxStartIndex(
                                            (prev) =>
                                                (prev + 1) %
                                                lightboxImages.length,
                                        )
                                    }
                                    className="absolute right-2 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 z-20 cursor-pointer"
                                >
                                    <ChevronRight size={28} />
                                </button>
                            )}
                        </div>
                        {lightboxImages.length > 1 && (
                            <div className="flex gap-2 max-w-[85vw] overflow-x-auto py-2 px-4 bg-black/40 backdrop-blur-sm rounded-full border border-white/5 custom-scrollbar">
                                {lightboxImages.map((img, i) => (
                                    <img
                                        key={i}
                                        src={img}
                                        className={`w-9 h-9 object-cover rounded-md cursor-pointer border transition-all ${i === lightboxStartIndex ? "border-indigo-500 scale-105 ring-2 ring-indigo-500/30" : "border-white/10 opacity-60 hover:opacity-100"}`}
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

    return (
        <>
            <div
                className="space-y-10 pb-32 animate-in fade-in duration-700"
                id="management-view"
            >
                <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex flex-col">
                        <h1 className="text-3xl font-black text-slate-900 uppercase tracking-tight">
                            {t("Dự Án Sản Xuất")}
                        </h1>
                        <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mt-1">
                            {t("Hệ thống quản lý sản xuất Xưởng 2")}
                        </p>
                    </div>
                    <div className="bg-white px-5 py-2 rounded-lg border border-slate-100 flex items-center space-x-3 shadow-none">
                        <Package size={18} className="text-indigo-600" />
                        <span className="text-xs font-black text-slate-900 uppercase tracking-[0.2em]">
                            {projects.length} {t("Dự Án")}
                        </span>
                    </div>
                </header>

                {isUpdatingOrder && (
                    <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-[999] flex flex-col items-center justify-center text-white font-sans gap-3">
                        <Loader2 className="animate-spin text-white w-10 h-10" />
                        <p className="text-xs font-black uppercase tracking-widest bg-slate-900/85 px-4 py-2 rounded">
                            {t("Đang sắp xếp lại thứ tự dự án...")}
                        </p>
                    </div>
                )}

                {/* Mobile: card list */}
                <div className="md:hidden space-y-3">
                    {projects.length > 0 ? (
                        projects.map((p) => {
                            const groupCode = customerProjectMap[p.code.toUpperCase()] || '';
                            const color = getProjectGroupColor(groupCode);
                            return (
                            <div
                                key={p.code}
                                onClick={() => setSelectedProject(p.code)}
                                className="bg-white rounded-xl border border-gray-200 active:bg-gray-100 transition-all flex overflow-hidden"
                            >
                                {groupCode ? (
                                    <div className={`w-10 shrink-0 flex items-center justify-center ${color.bg} ${color.text}`}>
                                        <span className="text-[10px] font-black uppercase" style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}>
                                            {groupCode}
                                        </span>
                                    </div>
                                ) : null}
                                <div className="flex-1 p-4 flex items-center justify-between">
                                    <div className="flex items-start space-x-3 min-w-0">
                                        <div className="min-w-0">
                                            <h4 className="text-sm font-black text-gray-900 truncate">{p.code}</h4>
                                            <div className="flex items-center space-x-2 mt-1">
                                                <span className="text-[10px] font-mono text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded uppercase truncate max-w-[180px] transition-all duration-300">
                                                    {p.name}
                                                </span>
                                                <span className={`text-[9px] font-black uppercase transition-all duration-300 ${p.isCompleted ? "text-emerald-500" : "text-blue-500"}`}>
                                                    {p.totalCount} {t("MODULE")}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <ChevronRight size={18} className="text-gray-300 ml-2 shrink-0" />
                                </div>
                            </div>
                            );
                        })
                    ) : (
                        <div className="py-12 text-center bg-white rounded-xl border border-dashed border-gray-200">
                            {loading ? (
                                <div className="flex flex-col items-center gap-2">
                                    <Loader2 size={32} className="animate-spin text-indigo-500" />
                                    <p className="text-[10px] font-black uppercase text-gray-400">{t("Đang tải dự án")}</p>
                                </div>
                            ) : (
                                <>
                                    <Package size={40} className="mx-auto mb-2 opacity-10" />
                                    <p className="text-[10px] font-black uppercase text-gray-300">{t("Chưa có dự án nào")}</p>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {/* Desktop: table view */}
                <div className="hidden md:block bg-white rounded shadow-sm border-t-4 border-primary">
                    <div className="px-4 py-3 border-b border-gray-100">
                        <h3 className="text-sm font-bold uppercase text-gray-700">{t("Danh sách Dự Án")} ({projects.length})</h3>
                    </div>
                    <div className="p-0 overflow-x-auto">
                        {projects.length > 0 ? (
                            <table className="w-full text-left border-collapse min-w-[800px]">
                                <thead>
                                    <tr className="bg-gray-100 text-gray-500 text-[10px] font-bold uppercase tracking-wider border-b border-gray-100">
                                        <th className="px-3 py-3 w-10 text-center">{t("Nhóm")}</th>
                                        <th className="px-4 py-3">{t("Mã dự án")}</th>
                                        <th className="px-4 py-3">{t("Tên dự án")}</th>
                                        <th className="px-4 py-3 text-center">{t("Module")}</th>
                                        <th className="px-4 py-3 text-center">{t("Tiến độ nhận")}</th>
                                        <th className="px-4 py-3">{t("Trạng thái")}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                    {projects.map((p) => (
                                        <tr
                                            key={p.code}
                                            onClick={() => setSelectedProject(p.code)}
                                            className="hover:bg-blue-100/30 transition-all duration-300 group cursor-pointer"
                                        >
                                            <td className="text-center border-r border-gray-100">
                                                {(() => {
                                                    const groupCode = customerProjectMap[p.code.toUpperCase()] || '';
                                                    const color = getProjectGroupColor(groupCode);
                                                    return groupCode ? (
                                                        <div className={`flex items-center justify-center h-full min-h-[52px] w-full ${color.bg} ${color.text}`}>
                                                            <span className="text-[11px] font-black uppercase tracking-wider" style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}>
                                                                {groupCode}
                                                            </span>
                                                        </div>
                                                    ) : <span className="text-[10px] text-slate-300">—</span>;
                                                })()}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className="text-sm font-black text-gray-900">{p.code}</span>
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className="text-xs font-mono text-gray-500 bg-gray-100 px-2 py-0.5 rounded">{p.name}</span>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <span className="text-xs font-bold text-gray-600 transition-all duration-300">{p.totalCount}</span>
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex flex-col items-center">
                                                    <span className="text-xs font-bold text-gray-600 transition-all duration-300">{p.receivedTotalCount}/{p.totalCount}</span>
                                                    <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden mt-1">
                                                        <div className="h-full bg-indigo-600 rounded-full transition-all duration-500 ease-out" style={{ width: `${p.detailDisplayPercent}%` }} />
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase border truncate max-w-[120px] inline-block transition-all duration-300 ${p.isCompleted ? "bg-emerald-100 text-emerald-600 border-emerald-100" : "bg-blue-100 text-blue-600 border-blue-100"}`}>
                                                    {p.isCompleted ? t("Hoàn tất") : p.latestStatus}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <div className="py-16 text-center text-gray-400">
                                {loading ? (
                                    <div className="flex flex-col items-center gap-3">
                                        <Loader2 size={40} className="animate-spin text-indigo-500" />
                                        <p className="text-xs font-black uppercase tracking-widest text-gray-400">{t("Đang tải dự án")}</p>
                                    </div>
                                ) : (
                                    <>
                                        <Package size={48} className="mx-auto mb-4 opacity-10" />
                                        <p className="text-sm font-bold uppercase tracking-widest opacity-30">{t("Chưa có Dự Án")}</p>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
            <dialog
                id="photo-dialog"
                className="m-auto bg-transparent p-0 backdrop:bg-black/90 backdrop:backdrop-blur-md rounded-lg max-w-4xl w-full outline-none"
                onClick={(e) => {
                    if (e.target === e.currentTarget)
                        (e.target as HTMLDialogElement).close();
                }}
            >
                <div className="flex flex-col items-center">
                    <div className="w-full flex items-center justify-between text-white p-2">
                        <span className="text-xs font-black uppercase tracking-wider font-mono">
                            {lightboxStartIndex + 1} / {lightboxImages.length}
                        </span>
                        <button
                            onClick={() =>
                                (
                                    document.getElementById(
                                        "photo-dialog",
                                    ) as HTMLDialogElement
                                )?.close()
                            }
                            className="p-2 hover:bg-white/10 rounded-full transition-all text-gray-300 hover:text-white cursor-pointer"
                        >
                            <X size={24} />
                        </button>
                    </div>
                    <div className="relative w-full flex items-center justify-center p-2">
                        {lightboxImages.length > 1 && (
                            <button
                                onClick={() =>
                                    setLightboxStartIndex(
                                        (prev) =>
                                            (prev - 1 + lightboxImages.length) %
                                            lightboxImages.length,
                                    )
                                }
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
                                onClick={() =>
                                    setLightboxStartIndex(
                                        (prev) =>
                                            (prev + 1) % lightboxImages.length,
                                    )
                                }
                                className="absolute right-2 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 z-20 cursor-pointer"
                            >
                                <ChevronRight size={28} />
                            </button>
                        )}
                    </div>
                    {lightboxImages.length > 1 && (
                        <div className="flex gap-2 max-w-[85vw] overflow-x-auto py-2 px-4 bg-black/40 backdrop-blur-sm rounded-full border border-white/5 custom-scrollbar">
                            {lightboxImages.map((img, i) => (
                                <img
                                    key={i}
                                    src={img}
                                    className={`w-9 h-9 object-cover rounded-md cursor-pointer border transition-all ${i === lightboxStartIndex ? "border-indigo-500 scale-105 ring-2 ring-indigo-500/30" : "border-white/10 opacity-60 hover:opacity-100"}`}
                                    onClick={() => setLightboxStartIndex(i)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </dialog>
        </>
    );
}
