/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from "react";
import { motion } from "motion/react";
import {
    X,
    ChevronLeft,
    ChevronRight,
    Plus,
    Loader2,
    ImageIcon,
    Camera,
    Package,
    Boxes,
} from "lucide-react";
import { ProjectEntry } from "../../types";
import { uploadToCloudinary } from "../../lib/cloudinary";
import {
    collection,
    query,
    getDocs,
    addDoc,
    updateDoc,
    doc,
    serverTimestamp,
    where,
} from "firebase/firestore";
import { db } from "../../lib/firebase";

interface PhotoItem {
    url: string;
    label: string;
    moduleCode: string;
    source: string;
}

interface AllPhotosByClusterModalProps {
    photosByCluster: Record<string, PhotoItem[]>;
    rawEntries: ProjectEntry[];
    selectedProject: string;
    canUpload: boolean;
    onClose: () => void;
    onPhotoAdded: () => void;
}

export function AllPhotosByClusterModal({
    photosByCluster,
    rawEntries,
    selectedProject,
    canUpload,
    onClose,
    onPhotoAdded,
}: AllPhotosByClusterModalProps) {
    const [lightboxImages, setLightboxImages] = useState<string[]>([]);
    const [lightboxIndex, setLightboxIndex] = useState(0);
    const [uploadingCluster, setUploadingCluster] = useState<string | null>(
        null,
    );
    const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

    const clusters = Object.keys(photosByCluster).sort((a, b) =>
        a.localeCompare(b, "vi"),
    );

    const openLightbox = (urls: string[], index: number) => {
        setLightboxImages(urls);
        setLightboxIndex(index);
    };

    const handleAddPhoto = async (
        cluster: string,
        files: FileList | null,
    ) => {
        if (!files || files.length === 0) return;
        setUploadingCluster(cluster);

        try {
            const clusterEntries = rawEntries.filter(
                (e) => (e.cluster || "") === cluster,
            );
            const targetEntry =
                clusterEntries.find((e) => getEntryType(e) === "Thùng") ||
                clusterEntries[0];
            if (!targetEntry) {
                alert("Không tìm thấy module trong cụm này.");
                return;
            }

            const urls: string[] = [];
            for (let i = 0; i < files.length; i++) {
                try {
                    const suffix = files.length > 1 ? `_${i + 1}` : "";
                    const url = await uploadToCloudinary(
                        files[i],
                        "QC",
                        `${selectedProject}_${(targetEntry.moduleCode || "module").replace(/[^a-zA-Z0-9]/g, "_")}_hoanthien${suffix}`,
                    );
                    urls.push(url);
                } catch (err) {
                    console.error("Lỗi upload ảnh:", err);
                }
            }

            if (urls.length === 0) {
                alert("Không thể tải lên ảnh nào.");
                return;
            }

            // Save to packing collection
            const packingQuery = query(
                collection(db, "packing"),
                where("projectCode", "==", selectedProject),
            );
            const packingSnap = await getDocs(packingQuery);

            const cleanCode = (targetEntry.moduleCode || "")
                .replace(/\s*#\d+\/\d+$/, "")
                .trim()
                .toLowerCase();

            let targetPackingDoc: any = null;
            let targetItemIdx = -1;

            packingSnap.docs.forEach((d) => {
                const data = d.data() as any;
                (data.items || []).forEach((item: any, idx: number) => {
                    const itemName = (item.name || "").toLowerCase().trim();
                    const itemCode = itemName
                        .replace(/\s*#\d+\/\d+$/, "")
                        .trim();
                    if (
                        itemCode === cleanCode ||
                        itemName.includes(cleanCode) ||
                        cleanCode.includes(itemCode)
                    ) {
                        targetPackingDoc = { id: d.id, ref: d.ref, data };
                        targetItemIdx = idx;
                    }
                });
            });

            if (targetPackingDoc && targetItemIdx >= 0) {
                const items = [...(targetPackingDoc.data.items || [])];
                const item = { ...items[targetItemIdx] };
                item.photos = [...(item.photos || []), ...urls];
                item.clusterPhotos = [
                    ...(item.clusterPhotos || []),
                    ...urls,
                ];
                items[targetItemIdx] = item;
                await updateDoc(
                    doc(db, "packing", targetPackingDoc.id),
                    { items },
                );
            } else {
                await addDoc(collection(db, "packing"), {
                    projectCode: selectedProject,
                    createdAt: serverTimestamp(),
                    items: [
                        {
                            id: targetEntry.id,
                            name: targetEntry.moduleCode || "",
                            photos: urls,
                            clusterPhotos: urls,
                            instanceIndex: 0,
                        },
                    ],
                });
            }

            onPhotoAdded();
        } catch (err) {
            console.error(err);
            alert(
                "Lỗi thêm ảnh: " +
                    (err instanceof Error ? err.message : String(err)),
            );
        } finally {
            setUploadingCluster(null);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="bg-white w-full max-w-4xl rounded-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[90vh]"
            >
                {/* Header */}
                <div className="px-5 py-4 bg-violet-600 text-white flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <ImageIcon size={20} />
                        <div>
                            <h3 className="text-sm font-black uppercase tracking-widest">
                                Ảnh Hoàn Thiện
                            </h3>
                            <p className="text-[10px] text-violet-200 font-bold uppercase">
                                {Object.values(photosByCluster).reduce(
                                    (s, p) => s + p.length,
                                    0,
                                )}{" "}
                                ảnh · {clusters.length} cụm
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 hover:bg-white/20 rounded-lg transition-colors cursor-pointer"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Scrollable cluster list */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {clusters.length === 0 ? (
                        <div className="py-16 text-center text-slate-400">
                            <ImageIcon
                                size={40}
                                className="mx-auto mb-3 text-slate-200"
                            />
                            <p className="text-xs font-black uppercase tracking-widest">
                                Chưa có ảnh nào
                            </p>
                        </div>
                    ) : (
                        clusters.map((cluster) => {
                            const photos = photosByCluster[cluster];
                            const clusterPhotos = photos.filter(
                                (p) => p.source === "cluster",
                            );
                            const qcPhotos = photos.filter(
                                (p) => p.source === "qc",
                            );
                            const packingPhotos = photos.filter(
                                (p) => p.source === "packing",
                            );
                            const isUploading = uploadingCluster === cluster;

                            return (
                                <div
                                    key={cluster}
                                    className="border border-slate-200 rounded-lg overflow-hidden"
                                >
                                    {/* Cluster header */}
                                    <div className="px-4 py-3 bg-slate-100 flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-black text-violet-600 bg-violet-100 px-2 py-0.5 rounded-lg uppercase tracking-widest">
                                                {cluster}
                                            </span>
                                            <span className="text-[9px] font-bold text-slate-400">
                                                {photos.length} ảnh
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {canUpload && (
                                                <>
                                                    <input
                                                        type="file"
                                                        accept="image/*"
                                                        multiple
                                                        className="hidden"
                                                        ref={(el) => {
                                                            fileInputRefs.current[cluster] =
                                                                el;
                                                        }}
                                                        onChange={(e) =>
                                                            handleAddPhoto(
                                                                cluster,
                                                                e.target.files,
                                                            )
                                                        }
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            fileInputRefs.current[
                                                                cluster
                                                            ]?.click()
                                                        }
                                                        disabled={isUploading}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-all active:scale-95 cursor-pointer disabled:opacity-50"
                                                    >
                                                        {isUploading ? (
                                                            <Loader2
                                                                size={12}
                                                                className="animate-spin"
                                                            />
                                                        ) : (
                                                            <Plus size={12} />
                                                        )}
                                                        <span>Thêm ảnh cụm</span>
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>

                                    {/* Cụm Photos section (uploaded via "Thêm ảnh cụm") */}
                                    {clusterPhotos.length > 0 && (
                                        <div className="px-4 pt-3 pb-1">
                                            <p className="text-[8px] font-black text-violet-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                                                <Boxes size={10} />
                                                Cụm ({clusterPhotos.length})
                                            </p>
                                            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-1.5">
                                                {clusterPhotos.map((photo, i) => {
                                                    const allUrls = clusterPhotos.map(
                                                        (p) => p.url,
                                                    );
                                                    const idxInAll =
                                                        allUrls.indexOf(
                                                            photo.url,
                                                        );
                                                    return (
                                                        <button
                                                            key={`${photo.url}-${i}`}
                                                            type="button"
                                                            className="relative rounded-lg overflow-hidden border border-slate-200 focus:outline-none block w-full cursor-pointer group"
                                                            onClick={() =>
                                                                openLightbox(
                                                                    allUrls,
                                                                    idxInAll,
                                                                )
                                                            }
                                                        >
                                                            <img
                                                                src={
                                                                    photo.url
                                                                }
                                                                alt={
                                                                    photo.label
                                                                }
                                                                className="w-full h-20 object-cover group-hover:scale-105 transition-transform"
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
                                                            <span className="absolute bottom-0 left-0 right-0 text-[6px] font-bold text-white bg-black/60 text-center py-0.5 uppercase truncate px-0.5">
                                                                {
                                                                    photo.moduleCode
                                                                }
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* QC Photos section */}
                                    {qcPhotos.length > 0 && (
                                        <div className="px-4 pt-3 pb-1">
                                            <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                                                <Camera size={10} />
                                                Ảnh QC ({qcPhotos.length})
                                            </p>
                                            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-1.5">
                                                {qcPhotos.map((photo, i) => {
                                                    const allUrls = qcPhotos.map(
                                                        (p) => p.url,
                                                    );
                                                    const idxInAll =
                                                        allUrls.indexOf(
                                                            photo.url,
                                                        );
                                                    return (
                                                        <button
                                                            key={`${photo.url}-${i}`}
                                                            type="button"
                                                            className="relative rounded-lg overflow-hidden border border-slate-200 focus:outline-none block w-full cursor-pointer group"
                                                            onClick={() =>
                                                                openLightbox(
                                                                    allUrls,
                                                                    idxInAll,
                                                                )
                                                            }
                                                        >
                                                            <img
                                                                src={
                                                                    photo.url
                                                                }
                                                                alt={
                                                                    photo.label
                                                                }
                                                                className="w-full h-20 object-cover group-hover:scale-105 transition-transform"
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
                                                            <span className="absolute bottom-0 left-0 right-0 text-[6px] font-bold text-white bg-black/60 text-center py-0.5 uppercase truncate px-0.5">
                                                                {
                                                                    photo.moduleCode
                                                                }{" "}
                                                                {photo.label}
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Packing Photos section */}
                                    {packingPhotos.length > 0 && (
                                        <div className="px-4 pt-2 pb-3">
                                            <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                                                <Package size={10} />
                                                Ảnh Đóng gói (
                                                {packingPhotos.length})
                                            </p>
                                            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-1.5">
                                                {packingPhotos.map(
                                                    (photo, i) => {
                                                        const allUrls =
                                                            packingPhotos.map(
                                                                (p) => p.url,
                                                            );
                                                        const idxInAll =
                                                            allUrls.indexOf(
                                                                photo.url,
                                                            );
                                                        return (
                                                            <button
                                                                key={`${photo.url}-${i}`}
                                                                type="button"
                                                                className="relative rounded-lg overflow-hidden border border-slate-200 focus:outline-none block w-full cursor-pointer group"
                                                                onClick={() =>
                                                                    openLightbox(
                                                                        allUrls,
                                                                        idxInAll,
                                                                    )
                                                                }
                                                            >
                                                                <img
                                                                    src={
                                                                        photo.url
                                                                    }
                                                                    alt={
                                                                        photo.label
                                                                    }
                                                                    className="w-full h-20 object-cover group-hover:scale-105 transition-transform"
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
                                                                <span className="absolute bottom-0 left-0 right-0 text-[6px] font-bold text-white bg-black/60 text-center py-0.5 uppercase truncate px-0.5">
                                                                    {
                                                                        photo.moduleCode
                                                                    }
                                                                </span>
                                                            </button>
                                                        );
                                                    },
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {photos.length === 0 && (
                                        <div className="px-4 py-4 text-center text-slate-300 text-[10px]">
                                            Chưa có ảnh trong cụm này
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-3 bg-slate-100 border-t border-slate-200 flex items-center justify-end">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-[10px] font-black uppercase tracking-widest rounded-lg transition-colors cursor-pointer"
                    >
                        Đóng
                    </button>
                </div>
            </motion.div>

            {/* Lightbox */}
            {lightboxImages.length > 0 && (
                <div
                    className="fixed inset-0 bg-black/90 z-[300] flex flex-col items-center justify-center"
                    onClick={(e) => {
                        if (e.target === e.currentTarget)
                            setLightboxImages([]);
                    }}
                >
                    <div className="w-full flex items-center justify-between text-white p-2">
                        <span className="text-xs font-black uppercase tracking-wider font-mono">
                            {lightboxIndex + 1} / {lightboxImages.length}
                        </span>
                        <button
                            onClick={() => setLightboxImages([])}
                            className="p-2 hover:bg-white/10 rounded-full transition-all text-gray-300 hover:text-white cursor-pointer"
                        >
                            <X size={24} />
                        </button>
                    </div>
                    <div className="relative w-full flex items-center justify-center p-2">
                        {lightboxImages.length > 1 && (
                            <button
                                onClick={() =>
                                    setLightboxIndex(
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
                        {lightboxImages[lightboxIndex] && (
                            <img
                                key={lightboxIndex}
                                src={lightboxImages[lightboxIndex]}
                                className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
                            />
                        )}
                        {lightboxImages.length > 1 && (
                            <button
                                onClick={() =>
                                    setLightboxIndex(
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
                                    className={`w-9 h-9 object-cover rounded-md cursor-pointer border transition-all ${
                                        i === lightboxIndex
                                            ? "border-violet-500 scale-105 ring-2 ring-violet-500/30"
                                            : "border-white/10 opacity-60 hover:opacity-100"
                                    }`}
                                    onClick={() => setLightboxIndex(i)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function getEntryType(entry: any): string {
    const code = (entry.moduleCode || "").toLowerCase();
    const name = (entry.moduleName || entry.name || "").toLowerCase();
    if (
        code.includes("len") ||
        code.includes("filler") ||
        code.includes("fillter") ||
        name.includes("len") ||
        name.includes("filler")
    ) {
        return "Len, Filler";
    }
    if (!code.includes("cửa") && !code.includes("cua") && !code.includes("mặt") && !code.includes("mat") && !code.includes("tấm hoàn thiện") && !code.includes("tam hoan thien") && !code.includes("hoàn thiện") && !code.includes("hoan thien") && !code.includes("ctht")) {
        return "Thùng";
    }
    if (code.includes("cánh") || code.includes("cua")) return "Cánh";
    if (code.includes("đợt") || code.includes("dot")) return "Đợt di động";
    if (code.includes("mặt") || code.includes("mat")) return "Mặt HK";
    return "CTHT";
}
