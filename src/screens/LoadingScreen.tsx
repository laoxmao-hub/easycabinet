/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from "react";
import {
    Inbox,
    Truck,
    X,
    PlusCircle,
    ChevronRight,
    Loader2,
    Search,
} from "lucide-react";
import {
    collection,
    query,
    orderBy,
    onSnapshot,
    addDoc,
    serverTimestamp,
    where,
} from "firebase/firestore";
import { useAuth } from "../lib/AuthContext";
import { useLanguage } from "../lib/LanguageContext";
import { db, handleFirestoreError, OperationType } from "../lib/firebase";
import { ProjectEntry, PKLOrder } from "../types";
import { formatProjectCode, formatProjectName } from "../lib/formatters";
import { PKLDetailScreen } from "../components/project/PKLDetailScreen";

interface LoadingScreenProps {
    projectEntries: ProjectEntry[];
    isGuest?: boolean;
    guestProjectCodes?: string[];
}

export function LoadingScreen({ projectEntries, isGuest = false, guestProjectCodes = [] }: LoadingScreenProps) {
    const { user, userProfile } = useAuth();
    const { t } = useLanguage();
    const [pklLists, setPklLists] = useState<PKLOrder[]>([]);
    const [selectedPklId, setSelectedPklId] = useState<string | null>(null);
    const [showPklCreateModal, setShowPklCreateModal] = useState(false);
    const [loading, setLoading] = useState(false);

    const [pklProjectCode, setPklProjectCode] = useState("");
    const [pklBatchName, setPklBatchName] = useState("");
    const [pklVehicleInfo, setPklVehicleInfo] = useState("");
    const [pklNote, setPklNote] = useState("");

    // Tìm kiếm module theo tên
    const [moduleSearchTerm, setModuleSearchTerm] = useState("");
    const [allLoadingHistories, setAllLoadingHistories] = useState<any[]>([]);

    useEffect(() => {
        const unsub = onSnapshot(collection(db, "loading_histories"), (snap) => {
            setAllLoadingHistories(
                snap.docs.map((d) => ({ id: d.id, ...d.data() } as any)),
            );
        });
        return unsub;
    }, []);

    const moduleSearchResults = useMemo(() => {
        if (!moduleSearchTerm.trim()) return [];
        const term = moduleSearchTerm.toLowerCase().trim();
        return allLoadingHistories
            .filter(
                (h) =>
                    h.packageName &&
                    h.packageName.toLowerCase().includes(term),
            )
            .sort((a: any, b: any) => {
                const tA = a.loadedAt?.seconds || 0;
                const tB = b.loadedAt?.seconds || 0;
                return tB - tA;
            });
    }, [moduleSearchTerm, allLoadingHistories]);

    useEffect(() => {
        if (!user) return;
        const q = query(
            collection(db, "loading"),
            orderBy("createdAt", "desc"),
        );
        const unsub = onSnapshot(
            q,
            (snapshot) => {
                let lists = snapshot.docs.map(
                    (docSnap) =>
                        ({ id: docSnap.id, ...docSnap.data() }) as PKLOrder,
                );
                // Guest: chỉ hiện phiếu có chứa hàng của dự án mình
                if (isGuest && guestProjectCodes.length > 0) {
                    lists = lists.filter(p => {
                        // Check projectCodes array
                        const pCodes = p.projectCodes || [];
                        if (pCodes.some(code => guestProjectCodes.includes(code))) return true;
                        // Fallback: check projectId
                        if (guestProjectCodes.includes(p.projectId)) return true;
                        if (p.projectId === 'all') return true;
                        return false;
                    });
                }
                setPklLists(lists);
            },
            (err) =>
                handleFirestoreError(err, OperationType.GET, "loading"),
        );
        return unsub;
    }, [user, isGuest, guestProjectCodes]);

    const projects = Array.from(
        new Set(projectEntries.map((p) => p.projectCode)),
    )
        .map((code) => {
            const entry = projectEntries.find((p) => p.projectCode === code);
            return {
                code,
                name: formatProjectName(entry?.projectName) || "Không tên",
            };
        })
        .reverse();

    const selectedPkl = pklLists.find((p) => p.id === selectedPklId);
    if (selectedPkl) {
        return (
            <PKLDetailScreen
                pkl={selectedPkl}
                onBack={() => setSelectedPklId(null)}
                projectEntries={projectEntries}
                isGuest={isGuest}
            />
        );
    }

    const handleCreatePkl = async () => {
        if (!user) return;
        setLoading(true);
        try {
            const proj = pklProjectCode
                ? projects.find((p) => p.code === pklProjectCode)
                : null;
            const projName =
                pklBatchName.trim() ||
                (proj
                    ? proj.name
                    : pklProjectCode
                      ? pklProjectCode
                      : "Nhiều Dự Án / Liên Kết");
            const finalProjectId = pklProjectCode || "all";

            const dateStr = new Date()
                .toISOString()
                .slice(0, 10)
                .replace(/-/g, "");
            const randHex = Math.floor(1000 + Math.random() * 9000);
            const generatedCode = `PKL-${dateStr}-${randHex}`;

            const displayLabel = userProfile?.ten_that
                ? `${userProfile.ten_that} (${userProfile.chuc_danh || "NV"})`
                : user?.displayName || "Anonymous";

            const docRef = await addDoc(collection(db, "loading"), {
                pklCode: generatedCode,
                projectId: finalProjectId,
                projectCodes: finalProjectId !== 'all' ? [finalProjectId] : [],
                projectName: projName,
                vehicleInfo: pklVehicleInfo,
                note: pklNote,
                status: 'open',
                createdBy: displayLabel,
                createdByEmail: user.email || "",
                createdAt: serverTimestamp(),
                packageIds: [],
                overallImages: [],
            });

            await addDoc(collection(db, "activities"), {
                userId: user.uid,
                userName: displayLabel,
                userEmail: user.email,
                action: "Tạo phiếu PKL",
                details: `Tạo phiếu PKL: ${generatedCode} xe ${pklVehicleInfo}`,
                projectCode: finalProjectId,
                timestamp: serverTimestamp(),
            });

            setShowPklCreateModal(false);
            setPklProjectCode("");
            setPklBatchName("");
            setPklVehicleInfo("");
            setPklNote("");
            setSelectedPklId(docRef.id);
        } catch (error) {
            handleFirestoreError(error, OperationType.CREATE, "loading");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-6 py-4 lg:pb-8">
            {/* Header */}
            <div className="w-full flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-black text-slate-900 uppercase tracking-tight">
                        {t("Lên Hàng")}
                    </h1>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mt-1">
                        Quản lý phiếu xếp hàng (PKL)
                    </p>
                </div>
                    {!isGuest && (
                <button
                    onClick={() => {
                        setPklProjectCode("");
                        setPklBatchName("");
                        setPklVehicleInfo("");
                        setPklNote("");
                        setShowPklCreateModal(true);
                    }}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-black uppercase tracking-wider shadow transition-all flex items-center cursor-pointer gap-1"
                >
                    <PlusCircle size={16} />
                    {t("Tạo PKL Mới")}
                </button>
                    )}
            </div>

            {/* Ô tìm kiếm module */}
            <div className="bg-white border border-slate-100 rounded-xl p-4 shadow-xs">
                <div className="flex items-center gap-2">
                    <Search size={16} className="text-slate-400 shrink-0" />
                    <input
                        type="text"
                        placeholder="Tìm module theo tên để biết đang ở xe nào..."
                        value={moduleSearchTerm}
                        onChange={(e) => setModuleSearchTerm(e.target.value)}
                        className="w-full bg-transparent text-sm font-bold text-slate-700 outline-none placeholder:text-slate-300"
                    />
                    {moduleSearchTerm && (
                        <button
                            onClick={() => setModuleSearchTerm("")}
                            className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>

                {moduleSearchTerm.trim() && (
                    <div className="mt-3 pt-3 border-t border-slate-100">
                        {moduleSearchResults.length === 0 ? (
                            <p className="text-xs text-slate-400 font-bold text-center py-4">
                                Không tìm thấy module "{moduleSearchTerm}" trong lịch sử lên xe
                            </p>
                        ) : (
                            <div className="space-y-2 max-h-[300px] overflow-y-auto">
                                <p className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                                    Tìm thấy {moduleSearchResults.length} kết quả
                                </p>
                                {moduleSearchResults.map((h: any) => (
                                    <div
                                        key={h.id}
                                        className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs font-black text-slate-800 truncate">
                                                {h.packageName}
                                            </p>
                                            <p className="text-[10px] text-slate-400 font-bold mt-0.5">
                                                {h.loadedAt
                                                    ? new Date(h.loadedAt.seconds * 1000).toLocaleString("vi-VN")
                                                    : ""}
                                            </p>
                                        </div>
                                        <button
                                            onClick={() => {
                                                const pkl = pklLists.find((p) => p.id === h.pklId);
                                                if (pkl) setSelectedPklId(pkl.id || null);
                                            }}
                                            className="ml-3 px-2.5 py-1 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 text-[10px] font-black uppercase rounded-lg border border-indigo-200 transition-colors cursor-pointer shrink-0"
                                        >
                                            Xe: {h.pklCode || "N/A"}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Mobile PKL List */}
            <div className="md:hidden space-y-3 font-sans">
                {pklLists.length > 0 ? (
                    pklLists.map((item) => (
                        <div
                            key={item.id}
                            onClick={() => setSelectedPklId(item.id || null)}
                            className="bg-white p-4 rounded-xl shadow-xs border border-slate-100 active:bg-gray-100 transition-all flex justify-between items-center cursor-pointer"
                        >
                            <div className="flex items-start space-x-3 min-w-0">
                                <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center bg-indigo-100 text-indigo-600">
                                    <Truck size={20} />
                                </div>
                                <div className="min-w-0">
                                    <h4 className="text-sm font-black text-slate-900 truncate">
                                        {item.projectName}
                                    </h4>
                                    <p className="text-xs text-slate-500 font-bold mt-0.5 truncate">
                                        {item.pklCode}
                                    </p>
                                    <div className="flex items-center space-x-2 mt-1">
                                        <span className="text-[9px] font-mono text-gray-500 bg-slate-100 px-1.5 py-0.5 rounded uppercase">
                                            Xe: {item.vehicleInfo || "N/A"}
                                        </span>
                                        <span className="text-[9px] text-slate-400 font-black">
                                            {((item as any).manualItems || []).length + ((item as any).scanQRItems || []).length} Kiện
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <ChevronRight
                                size={18}
                                className="text-gray-300 ml-2 shrink-0"
                            />
                        </div>
                    ))
                ) : (
                    <div className="py-12 text-center bg-white rounded-xl border border-dashed border-gray-200">
                        <Inbox
                            size={40}
                            className="mx-auto mb-2 opacity-15 text-slate-400"
                        />
                        <p className="text-[10px] font-black uppercase text-slate-400">
                            Chưa có phiếu PKL nào
                        </p>
                    </div>
                )}
            </div>

            {/* Desktop PKL List */}
            <div className="hidden md:block bg-white rounded-xl border border-slate-100 shadow-xs overflow-hidden font-sans">
                <div className="px-5 py-4 border-b border-slate-100 bg-slate-100/50">
                    <h3 className="text-xs font-black uppercase text-slate-500 tracking-wider">
                        {t("Danh Sách Packing List (PKL)")}
                    </h3>
                </div>

                <div className="p-0 overflow-x-auto">
                    {pklLists.length > 0 ? (
                        <table className="w-full text-left border-collapse min-w-[750px] font-sans">
                            <thead>
                                <tr className="bg-slate-100/30 border-b border-slate-100 text-[11px] font-black uppercase text-slate-400 tracking-wider">
                                    <th className="px-5 py-3">{t("Tên Đợt Hàng")}</th>
                                    <th className="px-5 py-3">{t("Mã PKL")}</th>
                                    <th className="px-5 py-3">{t("Phương Tiện")}</th>
                                    <th className="px-5 py-3">{t("Số lượng bốc")}</th>
                                    <th className="px-5 py-3">{t("Người lập")}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 text-sm">
                                {pklLists.map((item) => (
                                    <tr
                                        key={item.id}
                                        className="hover:bg-slate-100/50 transition-colors cursor-pointer"
                                        onClick={() =>
                                            setSelectedPklId(item.id || null)
                                        }
                                    >
                                        <td className="px-5 py-4 font-bold text-slate-800">
                                            {item.projectName}
                                        </td>
                                        <td className="px-5 py-4 font-mono text-xs text-slate-400">
                                            {item.pklCode}
                                        </td>
                                        <td className="px-5 py-4 font-medium text-slate-700">
                                            {item.vehicleInfo || `-${t("Chưa rõ")}`}
                                        </td>
                                        <td className="px-5 py-4 font-black text-slate-900">
                                            {((item as any).manualItems || []).length + ((item as any).scanQRItems || []).length} {t("Kiện")}
                                        </td>
                                        <td className="px-5 py-4 text-xs font-bold text-slate-500">
                                            {item.createdBy}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <div className="py-16 text-center text-slate-500 bg-white font-sans">
                            <Inbox
                                size={48}
                                className="mx-auto mb-3 opacity-15 text-slate-400"
                            />
                            <p className="text-xs font-extrabold uppercase tracking-widest text-slate-400">
                                Không tìm thấy phiếu PKL nào
                            </p>
                            <p className="text-[10px] text-slate-400 font-bold mt-1.5">
                                {t('Bấm nút "Tạo PKL Mới" ở góc phải để bắt đầu xếp')}
                                hàng
                            </p>
                        </div>
                    )}
                </div>
            </div>

            {/* Modal Tạo Mới PKL */}
            {showPklCreateModal && (
                <div className="fixed inset-0 z-[110] bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
                    <div className="bg-white border border-slate-105 rounded-xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col font-sans">
                        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                            <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight">
                                {t("Tạo Phiếu Lên Hàng (PKL)")}
                            </h3>
                            <button
                                onClick={() => setShowPklCreateModal(false)}
                                className="text-slate-400 hover:text-rose-500 cursor-pointer"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        <div className="p-6 space-y-4 overflow-y-auto max-h-[70vh]">
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                                    Chọn Dự Án
                                </label>
                                <select
                                    value={pklProjectCode}
                                    onChange={(e) =>
                                        setPklProjectCode(e.target.value)
                                    }
                                    className="w-full border border-slate-200 rounded-lg px-3.5 py-2.5 text-sm font-bold focus:ring-2 focus:ring-indigo-500 focus:outline-none uppercase"
                                >
                                    <option value="">
                                        -- LIÊN DỰ ÁN (XẾP XE NHIỀU DỰ ÁN) --
                                    </option>
                                    {projects.map((proj) => (
                                        <option
                                            key={proj.code}
                                            value={proj.code}
                                        >
                                            {proj.code} - {proj.name}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                                    Tên Đợt Hàng
                                </label>
                                <input
                                    type="text"
                                    placeholder="Để trống sẽ lấy tên dự án"
                                    value={pklBatchName}
                                    onChange={(e) =>
                                        setPklBatchName(e.target.value)
                                    }
                                    className="w-full border border-slate-200 rounded-lg px-3.5 py-2.5 text-sm font-bold focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                                    Thông Tin Xe Vận Chuyển
                                </label>
                                <input
                                    type="text"
                                    placeholder="VD: Xe tải 5T - BKS 29C-123.45"
                                    value={pklVehicleInfo}
                                    onChange={(e) =>
                                        setPklVehicleInfo(e.target.value)
                                    }
                                    className="w-full border border-slate-200 rounded-lg px-3.5 py-2.5 text-sm font-bold focus:ring-2 focus:ring-indigo-500 focus:outline-none font-sans"
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                                    Ghi Chú
                                </label>
                                <textarea
                                    placeholder="VD: Giao hàng đợt 1..."
                                    value={pklNote}
                                    onChange={(e) => setPklNote(e.target.value)}
                                    rows={2}
                                    className="w-full border border-slate-200 rounded-lg px-3.5 py-2.5 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                                />
                            </div>
                        </div>

                        <div className="px-6 py-4 bg-slate-100 border-t border-slate-100 flex items-center justify-end gap-3">
                            <button
                                onClick={() => setShowPklCreateModal(false)}
                                className="px-4 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-700 hover:bg-slate-100 cursor-pointer"
                            >
                                HỦY
                            </button>
                            <button
                                onClick={handleCreatePkl}
                                disabled={loading || !pklVehicleInfo.trim()}
                                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase tracking-wider text-xs rounded-lg shadow active:scale-95 disabled:opacity-100 flex items-center justify-center gap-1 cursor-pointer"
                            >
                                {loading ? (
                                    <Loader2
                                        size={14}
                                        className="animate-spin"
                                    />
                                ) : (
                                    "XÁC NHẬN"
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
