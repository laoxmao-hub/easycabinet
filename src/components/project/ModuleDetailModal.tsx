import React from "react";
import { motion } from "motion/react";
import {
 CheckCircle,
 AlertTriangle,
 X,
 Info,
 Boxes,
 History,
 Cuboid,
 Edit,
 Save,
 Loader2,
 Image as ImageIcon,
 ChevronLeft,
 ChevronRight,
 Package,
 Truck,
} from "lucide-react";
import { useAuth } from "../../lib/AuthContext";
import { useLanguage } from "../../lib/LanguageContext";
import {
 ProjectEntry,
 getModuleInstances,
 getInstanceStageQc,
} from "../../types";
import { ModuleThreeViewer, MatchLogEntry } from "./ModuleThreeViewer";
import { QcStageBadges } from "../QcStageBadges";
import {
 collection,
 addDoc,
 serverTimestamp,
 query,
 onSnapshot,
 where,
 getDocs,
 doc,
} from "firebase/firestore";
import { db, cleanUndefinedFields } from "../../lib/firebase";
import { updateProjectModule, findProjectConfigId } from "../../lib/dualWrite";
import { getModuleQcAggregate } from "../../types";

// Hàm phân loại cấu kiện
const getEntryType = (
 entry: ProjectEntry,
): "Thùng" | "Cánh" | "Đợt" | "Mặt HK" | "CTHT" | "Gia công ngoài" => {
 if (entry.classification) {
 if (
 entry.classification === "Gia Công Ngoài" ||
 (entry.classification as string) === "Gia công ngoài"
 ) {
 return "Gia công ngoài";
 }
 return entry.classification as any;
 }
 const code = entry.moduleCode || "";
 const codeLower = code.toLowerCase();

 if (
 codeLower.includes("-gcn") ||
 codeLower.includes("gcn") ||
 codeLower.includes("gia cong ngoai") ||
 codeLower.includes("giacongngoai") ||
 codeLower.includes("outsource")
 ) {
 return "Gia công ngoài";
 }

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
 if (codeLower.includes("đợt") || codeLower.includes("dot")) {
 return "Đợt";
 }
 return "Thùng";
 }

 if (
 codeLower.includes("cánh") ||
 codeLower.includes("canh") ||
 codeLower.includes("cửa") ||
 codeLower.includes("cua")
 ) {
 return "Cánh";
 }

 if (codeLower.includes("đợt") || codeLower.includes("dot")) {
 return "Đợt";
 }

 if (codeLower.includes("mặt") || codeLower.includes("mat")) {
 return "Mặt HK";
 }

 return "CTHT";
};

const getEntryTypeLocal = (moduleCode: string, entry?: any): string => {
 return getEntryType(entry || { moduleCode });
};

interface ModuleDetailModalProps {
 module: ProjectEntry;
 onClose: () => void;
 projectAccessories?: any[];
 allEntries?: ProjectEntry[];
 onOpenModule?: (m: ProjectEntry) => void;
 qcStage?: string; // Chỉ hiển thị QC giai đoạn này (white/paint/finish/pack)
 instanceIndex?: number; // Chỉ hiển thị instance này
 onOpenPacking?: (instIdx?: number) => void;
} export const ModuleDetailModal = React.memo(
 ({
   module,
   onClose,
   projectAccessories = [],
   allEntries = [],
   onOpenModule,
   qcStage,
   instanceIndex,
   onOpenPacking,
 }: ModuleDetailModalProps) => {
 const { role, roles, user, userProfile, hasRole } = useAuth();
 const { unit, t } = useLanguage();
 const [showAllTempLabels, setShowAllTempLabels] = React.useState(false);

 const [localModule, setLocalModule] = React.useState<ProjectEntry>(module);
 const [isEditing, setIsEditing] = React.useState(false);
 const [editLoading, setEditLoading] = React.useState(false);

 React.useEffect(() => {
 setLocalModule(module);
 }, [module]);

 // Real-time sync chi tiết module từ Firestore — tránh hiển thị dữ liệu stale
 // (vd: instance đã đóng gói nhưng badge vẫn "CẦN ĐÓNG" vì packStatus mới
 // chỉ được ghi vào module doc, không phải projectEntries ở App)
 React.useEffect(() => {
  if (!module?.id) return;
  let unsub: (() => void) | undefined;
  let disposed = false;

  const attach = (configId: string) => {
   const moduleRef = doc(db, "projectConfigs", configId, "modules", module.id);
   unsub = onSnapshot(
    moduleRef,
    (snap) => {
     if (!snap.exists()) return;
     setLocalModule((prev) => ({
      ...prev,
      ...snap.data(),
      id: snap.id,
     } as ProjectEntry));
    },
    (err) => {
     console.warn("Lỗi đồng bộ chi tiết module:", err);
    },
   );
  };

  if (module.configId) {
   attach(module.configId);
  } else {
   // Entry không kèm configId → resolve qua projectCode (projectCode ≠ configId)
   findProjectConfigId(module.projectCode || "")
    .then((cid) => {
     if (!disposed && cid) attach(cid);
    })
    .catch(() => {});
  }

  return () => {
   disposed = true;
   if (unsub) unsub();
  };
 }, [module?.id, module?.configId, module?.projectCode]);

 const matchedEntry = localModule;

 const [packingPhotos, setPackingPhotos] = React.useState<{ url: string; instanceIndex?: number }[]>([]);
 const [lightboxImages, setLightboxImages] = React.useState<string[]>([]);
 const [lightboxStartIndex, setLightboxStartIndex] = React.useState<number>(0);

 React.useEffect(() => {
  if (!matchedEntry) { setPackingPhotos([]); return; }
  const cleanCode = matchedEntry.moduleCode.replace(/\s*#\d+\/\d+$/, '').trim().toLowerCase();
  const moduleId = matchedEntry.id || '';
  const projectCode = matchedEntry.projectCode || '';

  // Query packing theo projectCode để lấy đúng phiếu đóng gói của dự án
  const q = projectCode
   ? query(collection(db, "packing"), where("projectCode", "==", projectCode))
   : query(collection(db, "packing"));

  const unsub = onSnapshot(q, (snap) => {
   const photos: { url: string; instanceIndex?: number }[] = [];
   const seenUrls = new Set<string>();

   snap.docs.forEach((d) => {
    const list = d.data() as any;
    (list.items || []).forEach((item: any) => {
     const itemName = (item.name || '').toLowerCase().trim();
     const itemCode = itemName.replace(/\s*#\d+\/\d+$/, '').trim();
     const itemId = item.id || '';
     const matchesByName = itemCode === cleanCode;
     const matchesById = moduleId && itemId.startsWith(moduleId);
     if (matchesByName || matchesById) {
      // Nếu đang xem instance cụ thể → chỉ lấy ảnh instance đó
      if (instanceIndex != null && item.instanceIndex != null && item.instanceIndex !== instanceIndex) return;
      const instIdx = item.instanceIndex;
      if (item.photos?.length) {
       item.photos.filter(Boolean).forEach((p: string) => {
        if (!seenUrls.has(p)) { seenUrls.add(p); photos.push({ url: p, instanceIndex: instIdx }); }
       });
      }
      if (item.productImageUrl && !seenUrls.has(item.productImageUrl)) {
       seenUrls.add(item.productImageUrl);
       photos.push({ url: item.productImageUrl, instanceIndex: instIdx });
      }
      if (item.packingImageUrl && !seenUrls.has(item.packingImageUrl)) {
       seenUrls.add(item.packingImageUrl);
       photos.push({ url: item.packingImageUrl, instanceIndex: instIdx });
      }
     }
    });
   });
   setPackingPhotos(photos);
  }, () => setPackingPhotos([]));
  return unsub;
 }, [matchedEntry?.id, instanceIndex]); const [detailMatchLogs, setDetailMatchLogs] = React.useState<MatchLogEntry[]>([]);

 const [formValues, setFormValues] = React.useState({
  moduleCode: module.moduleCode || "",
  cluster: module.cluster || "",
  classification: module.classification || "",
  width: module.width ?? "",
  depth: module.depth ?? "",
  height: module.height ?? "",
  pWidth: module.pWidth ?? "",
  pDepth: module.pDepth ?? "",
  pHeight: module.pHeight ?? "",
  quantity: module.quantity ?? 1,
  assemblyQuantity: module.assemblyQuantity ?? "",
  material: module.material || "",
  area: module.area || "",
  unit: module.unit || "",
  drawingUrl: module.drawingUrl || "",
  assemblyDrawingUrl: module.assemblyDrawingUrl || "",
  glbUrl: module.glbUrl || "",
 });

 const handleStartEdit = () => {
 setFormValues({
 moduleCode: localModule.moduleCode || "",
 cluster: localModule.cluster || "",
 classification: localModule.classification || "",
 width: localModule.width ?? "",
 depth: localModule.depth ?? "",
 height: localModule.height ?? "",
 pWidth: localModule.pWidth ?? "",
 pDepth: localModule.pDepth ?? "",
 pHeight: localModule.pHeight ?? "",
 quantity: localModule.quantity ?? 1,
 assemblyQuantity: localModule.assemblyQuantity ?? "",
 material: localModule.material || "",
 area: localModule.area || "",
 unit: localModule.unit || "",
 drawingUrl: localModule.drawingUrl || "",
 assemblyDrawingUrl: localModule.assemblyDrawingUrl || "",
 glbUrl: localModule.glbUrl || "",
 });
 setIsEditing(true);
 };

 const handleSaveEdit = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!user) return;
 setEditLoading(true);

 try {
 const updatedFields: any = {
 moduleCode: formValues.moduleCode.trim(),
 cluster: formValues.cluster.trim(),
 classification: (formValues.classification as any) || null,
 width: formValues.width !== "" ? Number(formValues.width) : null,
 depth: formValues.depth !== "" ? Number(formValues.depth) : null,
 height: formValues.height !== "" ? Number(formValues.height) : null,
 pWidth: formValues.pWidth !== "" ? Number(formValues.pWidth) : null,
 pDepth: formValues.pDepth !== "" ? Number(formValues.pDepth) : null,
 pHeight:
 formValues.pHeight !== "" ? Number(formValues.pHeight) : null,
 quantity: Number(formValues.quantity) || 1,
 assemblyQuantity:
 formValues.assemblyQuantity !== ""
 ? Number(formValues.assemblyQuantity)
 : null,
 material: formValues.material.trim(),
 area: formValues.area.trim(),
 unit: formValues.unit.trim(),
 drawingUrl: formValues.drawingUrl.trim(),
 assemblyDrawingUrl: formValues.assemblyDrawingUrl.trim(),
 glbUrl: formValues.glbUrl.trim(),
 };

 const cleaned = cleanUndefinedFields(updatedFields);

 setLocalModule((prev) => ({
 ...prev,
 ...cleaned,
 }));

 await updateProjectModule(localModule.id, cleaned, localModule.projectCode);

 await addDoc(collection(db, "activities"), {
 userId: user.uid,
 userName: user.displayName || "Anonymous",
 userEmail: user.email,
 action: "Chỉnh sửa cấu kiện",
 details: `Cập nhật thông tin cấu kiện ${formValues.moduleCode.trim()} (ID: ${localModule.id}) - Edit Detail Modal`,
 projectCode: localModule.projectCode,
 moduleCode: formValues.moduleCode.trim(),
 timestamp: serverTimestamp(),
 });

 setIsEditing(false);
 } catch (error: any) {
 console.error("Lỗi khi cập nhật cấu kiện:", error);
 alert("Không thể cập nhật cấu kiện: " + error.message);
 } finally {
 setEditLoading(false);
 }
 };

 // Đối tượng result dự phòng để đồng nhất hiển thị khi lấy code gốc từ QuickScanner
 const result = {
 rawCode: matchedEntry.moduleCode,
 moduleCode: matchedEntry.moduleCode,
 cluster: matchedEntry.cluster,
 width: matchedEntry.width,
 depth: matchedEntry.depth,
 height: matchedEntry.height,
 instanceId: null,
  notes: "",
 };

 const projectEntries = allEntries;

 return (
 <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
 <div className="absolute inset-0" onClick={onClose} />

 <motion.div
 initial={{ opacity: 0, scale: 0.95, y: 15 }}
 animate={{ opacity: 1, scale: 1, y: 0 }}
 exit={{ opacity: 0, scale: 0.95, y: 15 }}
 className="bg-white rounded-lg border border-slate-200 overflow-hidden flex flex-col w-full max-w-2xl lg:max-w-5xl max-h-[90vh] shadow-xl relative z-10"
 >
 {/* Header */}
 <div
 className={`p-4 md:p-6 flex items-center justify-between text-white shrink-0 ${matchedEntry ? "bg-emerald-600" : "bg-orange-500"}`}
 >
 <div className="flex items-center gap-3 md:gap-4 text-left">
 <div className="w-10 h-10 md:w-12 md:h-12 bg-white/20 rounded-lg flex items-center justify-center backdrop-blur-md">
 {matchedEntry ? (
 <CheckCircle size={22} />
 ) : (
 <AlertTriangle size={22} />
 )}
 </div>
 <div>
 <h3 className="font-extrabold text-sm md:text-base uppercase tracking-tight leading-none mb-1 md:mb-1.5">
 {matchedEntry
 ? (matchedEntry.displayName || matchedEntry.moduleCode)  : t('Mã QR Không Thuộc Dự Án')}
 </h3>
 <p className="text-[9px] md:text-[10px] font-black uppercase tracking-widest opacity-80 leading-none">
   {matchedEntry
     ? `${matchedEntry.moduleCode} · ${matchedEntry.projectName}`
     : t('Thông tin truy xuất')}
 </p>
 </div>
 </div>
 <button
 onClick={onClose}
 className="p-2 hover:bg-white/20 rounded-lg transition-colors cursor-pointer"
 >
 <X size={20} />
 </button>
 </div>

 {/* Content Area */}
 <div className="p-4 md:p-6 space-y-4 md:space-y-6 overflow-y-auto flex-1 bg-white custom-scrollbar text-slate-800">
 {isEditing ? (
 <form
 onSubmit={handleSaveEdit}
 className="space-y-5 text-left pb-4"
 >
 <div className="flex items-center gap-2 border-b border-indigo-100 pb-2 mb-4">
 <Info size={14} className="text-indigo-600" />  <h4 className="text-[10px] font-black text-indigo-900 uppercase tracking-widest leading-none">
  {t('Biểu mẫu Chỉnh sửa cấu kiện')}
  </h4>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 {/*  {t('Mã cấu kiện')} */}
 <div className="space-y-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">
  {t('Mã cấu kiện')} *
 </label>
 <input
 required
 type="text"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.moduleCode}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 moduleCode: e.target.value,
 })
 }
 />
 </div>

 {/* Phân loại */}
 <div className="space-y-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">
 Phân loại
 </label>
 <select
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.classification}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 classification: e.target.value,
 })
 }
 >
 <option value="">-- Chọn phân loại --</option>
 <option value="Thùng">Thùng</option>
 <option value="Cánh">Cánh</option>
 <option value="Đợt">Đợt</option>
 <option value="Mặt HK">Mặt HK</option>
 <option value="CTHT">CTHT</option>
 <option value="Len, Filler">Len, Filler</option>
 <option value="Gia công ngoài">Gia công ngoài</option>
 </select>
 </div>

 {/* Cụm / Khu vực */}
 <div className="space-y-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">
 Cụm / Khu vực
 </label>
 <input
 type="text"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.cluster}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 cluster: e.target.value,
 })
 }
 />
 </div>

 {/* Vật liệu */}
 <div className="space-y-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">
 Vật liệu
 </label>
 <input
 type="text"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.material}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 material: e.target.value,
 })
 }
 />
 </div>

 {/* Kích thước Thiết kế */}
 <div className="space-y-1 md:col-span-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">  {t('Kích thước Thiết kế (Rộng x Sâu x Cao) (mm)')}
 </label>
 <div className="grid grid-cols-3 gap-2">
 <input
 type="number"
 placeholder="Rộng"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.width}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 width: e.target.value,
 })
 }
 />
 <input
 type="number"
 placeholder="Sâu"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.depth}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 depth: e.target.value,
 })
 }
 />
 <input
 type="number"
 placeholder="Cao"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.height}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 height: e.target.value,
 })
 }
 />
 </div>
 </div>

 {/* Kích thước Sản xuất */}
 <div className="space-y-1 md:col-span-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">  {t('Kích thước Sản xuất (pWidth x pDepth x pHeight) (mm)')}
 </label>
 <div className="grid grid-cols-3 gap-2">
 <input
 type="number"
 placeholder="Rộng sản xuất (pWidth)"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.pWidth}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 pWidth: e.target.value,
 })
 }
 />
 <input
 type="number"
 placeholder="Sâu sản xuất (pDepth)"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.pDepth}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 pDepth: e.target.value,
 })
 }
 />
 <input
 type="number"
 placeholder="Cao sản xuất (pHeight)"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.pHeight}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 pHeight: e.target.value,
 })
 }
 />
 </div>
 </div>

 {/* Số lượng tổng */}
 <div className="space-y-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">  {t('Số lượng (Tổng)')} *
 </label>
 <input
 required
 type="number"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.quantity}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 quantity: Number(e.target.value) || 1,
 })
 }
 />
 </div>

 {/*  {t('Số lượng lắp ráp')} */}
 <div className="space-y-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">
  {t('Số lượng lắp ráp')}
 </label>
 <input
 type="number"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.assemblyQuantity}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 assemblyQuantity: e.target.value,
 })
 }
 />
 </div>

 {/* Tầng/Khu vực & Đơn vị/Tòa */}
 <div className="space-y-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">  {t('Tầng / Khu vực (Area)')}
 </label>
 <input
 type="text"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.area}
 onChange={(e) =>
 setFormValues({ ...formValues, area: e.target.value })
 }
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">  {t('Đơn vị / Block (Unit)')}
 </label>
 <input
 type="text"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={formValues.unit}
 onChange={(e) =>
 setFormValues({ ...formValues, unit: e.target.value })
 }
 />
 </div>

 {/* Link bản vẽ PDF / Image */}
 <div className="space-y-1 md:col-span-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">  {t('Link Bản vẽ chi tiết (PDF/Hình ảnh/...)')}
 </label>
 <input
 type="text"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 placeholder="Dán link bản vẽ chi tiết..."
 value={formValues.drawingUrl}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 drawingUrl: e.target.value,
 })
 }
 />
 </div>

 {/* Link bản vẽ lắp ráp */}
 <div className="space-y-1 md:col-span-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">  {t('Link Bản vẽ lắp ráp (PDF/Hình ảnh/...)')}
 </label>
 <input
 type="text"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 placeholder="Dán link bản vẽ lắp ráp..."
 value={formValues.assemblyDrawingUrl}
 onChange={(e) =>
 setFormValues({
 ...formValues,
 assemblyDrawingUrl: e.target.value,
 })
 }
 />
 </div>

 {/* Link Web GLB */}
 <div className="space-y-1 md:col-span-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l-2 border-indigo-500 pl-1.5 block">  {t('Đường dẫn Mô hình 3D (.glb)')}
 </label>
 <input
 type="text"
 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 bg-slate-100 focus:border-indigo-600 outline-none transition-all shadow-none"
 placeholder="Dán link mô hình 3D .glb..."
 value={formValues.glbUrl}
 onChange={(e) =>
 setFormValues({ ...formValues, glbUrl: e.target.value })
 }
 />
 </div>
 </div>

 {/* Force buttons under editing */}
 <div className="flex space-x-3 pt-5 border-t border-slate-100 mt-6">
 <button
 type="button"
 onClick={() => setIsEditing(false)}
 className="px-6 py-2.5 bg-slate-100 text-slate-700 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-all cursor-pointer"
 >
 Huỷ bỏ
 </button>
 <button
 disabled={editLoading}
 type="submit"
 className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase tracking-widest text-[10px] hover:shadow-lg hover:shadow-indigo-100 transition-all disabled:opacity-100 flex items-center justify-center space-x-2 cursor-pointer"
 >
 {editLoading ? (
 <Loader2 size={14} className="animate-spin" />
 ) : (
 <>
 <Save size={14} />
 <span>  {t('Ghi nhận thay đổi')}</span>
 </>
 )}
 </button>
 </div>
 </form>
 ) : (
 <>
 {/* Định danh */}
 <div className="flex flex-col items-center gap-1.5 pt-2"> <div className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">
   {t('Mã số định danh')}
 </div>
 <div className="text-xl md:text-2xl font-black text-slate-900 font-mono tracking-tighter text-center break-all uppercase">
 {matchedEntry
 ? (matchedEntry.displayName || matchedEntry.moduleCode)
 : t('Không xác định')}
 {instanceIndex != null && matchedEntry && (
 <span className="ml-2 text-indigo-600 normal-case">- Kiện {instanceIndex}/{matchedEntry.quantity || 1}</span>
 )}
 </div>
 {matchedEntry?.displayName && (
 <div className="text-[10px] font-mono text-slate-400 text-center mt-1">
 {matchedEntry.moduleCode}
 </div>
 )}
 <div className="flex items-center gap-2 mt-1 flex-wrap justify-center">
 {matchedEntry && (  <span className="px-2 py-0.5 bg-indigo-100 text-indigo-600 rounded-lg text-[8px] md:text-[9.5px] font-black uppercase tracking-widest border border-indigo-100">
   {t('Phân loại')}: {getEntryType(matchedEntry)}
  </span>
 )}
 {matchedEntry && (
 <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded-lg text-[8px] md:text-[9.5px] font-black uppercase tracking-widest border border-slate-200">
 ID: {matchedEntry.id}
 </span>
 )}
 </div>
 </div>

 {matchedEntry && (
 <div className="space-y-6">
 {/* 1. THÔNG TIN CƠ BẢN + TIẾN ĐỘ GIAO NHẬN */}
 <div className="bg-slate-100/50 rounded-lg p-4 border border-slate-100 space-y-4">
 <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
 <Info
 size={14}
 className="text-indigo-600"
 />  <h4 className="text-[10px] font-black text-slate-800 uppercase tracking-widest leading-none">
   {t('Thông tin cấu kiện cơ bản')}
  </h4>
 </div>

  <div className="grid grid-cols-2 gap-4">
  <div className="space-y-1">  <p className="text-[8.5px] font-black text-slate-400 uppercase tracking-widest leading-none">
    {t('Cụm / Khu vực')}
   </p>
   <p className="text-[12.5px] font-black text-slate-800 uppercase leading-none">
    {matchedEntry.cluster ||
    t('Chưa phân cụm')}
 </p>
 </div>  {matchedEntry.width !== 0 && matchedEntry.depth !== 0 && matchedEntry.height !== 0 && matchedEntry.pWidth !== 0 && matchedEntry.pDepth !== 0 && matchedEntry.pHeight !== 0 && (
  <div className="space-y-1">  <p className="text-[8.5px] font-black text-slate-400 uppercase tracking-widest leading-none">
    {unit === 'inch' ? t('Kích thước (D x R x C) (in)') : t('Kích thước (D x R x C) (mm)')}
   </p>
                   <p className="text-[12px] font-black text-slate-700 font-mono leading-none">
                     {unit === 'inch'
                       ? `${((matchedEntry.pWidth ?? matchedEntry.width ?? 0) / 25.4).toFixed(1)}"x${((matchedEntry.pDepth ?? matchedEntry.depth ?? 0) / 25.4).toFixed(1)}"x${((matchedEntry.pHeight ?? matchedEntry.height ?? 0) / 25.4).toFixed(1)}"`
                       : `${matchedEntry.pWidth ?? matchedEntry.width ?? 0}x${matchedEntry.pDepth ?? matchedEntry.depth ?? 0}x${matchedEntry.pHeight ?? matchedEntry.height ?? 0}`}
                   </p>
 </div>
 )}
 </div>

 {/* Tiến độ giao nhận */}
 <div className="pt-2 border-t border-slate-200/60">
 <div className="flex justify-between items-center mb-1.5">  <p className="text-[8.5px] font-black text-slate-400 uppercase tracking-widest leading-none">
   {t('Tiến độ Giao Nhận dự án')}
  </p>
 <span
 className={`text-[9px] font-black px-1.5 py-0.5 rounded-sm uppercase tracking-tight $  {matchedEntry.receivedQuantity === matchedEntry.quantity ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-500"}`}
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

 </div>

 {/* 2. MÔ HÌNH 3D */}
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
 return (
 <div className="w-full space-y-2.5 text-left bg-slate-100/50 rounded-lg p-4 border border-slate-200/60 font-sans">
 <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
 <Cuboid size={14} className="text-indigo-600 animate-pulse" />  <h4 className="text-[10px] font-black text-slate-800 uppercase tracking-widest leading-none">
   {t('Mô hình 3D cấu kiện (CAD ISO View)')}
  </h4>  </div> <ModuleThreeViewer
    url={projectGlbUrl}
    moduleName={matchedEntry.objectName || matchedEntry.moduleCode}
    cameraAngle={matchedEntry.cameraAngle}
    onMatchLog={setDetailMatchLogs}
    customFadedKeys={
      (matchedEntry.objectClusterName || '')
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(Boolean)
    }
    customClearKeys={
      (matchedEntry.objectName || '')
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(Boolean)
    }
  />
  {/* {detailMatchLogs.length > 0 && (() => {
    const clearLogs = detailMatchLogs.filter(l => l.state === 'clear');
    const fadedLogs = detailMatchLogs.filter(l => l.state === 'faded');
    const hiddenLogs = detailMatchLogs.filter(l => l.state === 'hidden');
    const moduleFadedKey = detailMatchLogs[0]?.fadedKey || '';
    const moduleClearKey = detailMatchLogs[0]?.clearKey || '';
    if (!moduleFadedKey && !moduleClearKey) return null;
    return (
     <div className="mt-2 pt-2 border-t border-slate-200/60">
      <div className="flex items-center gap-1.5 mb-2">
       <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Match Log:</span>
       <span className="text-[8px] font-bold text-emerald-600 bg-emerald-100 px-1.5 py-0.5 rounded-sm">
        {clearLogs.length} Clear
       </span>
       <span className="text-[8px] font-bold text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded-sm">
        {fadedLogs.length} Faded
       </span>
       <span className="text-[8px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-sm">
        {hiddenLogs.length} Hidden
       </span>
      </div>
      {(moduleFadedKey || moduleClearKey) && (
       <div className="bg-gradient-to-r from-amber-50 to-emerald-50 border border-slate-200 rounded-lg p-2">
        <div className="grid grid-cols-2 gap-2">
         <div className="bg-white rounded-md px-2 py-1.5 border border-amber-200">
          <p className="text-[7px] font-black text-amber-500 uppercase tracking-wider mb-0.5">
           Faded Key
          </p>
          <p className="text-[10px] font-mono font-bold text-amber-700 break-all">
           {moduleFadedKey || '(không có)'}
          </p>
         </div>
         <div className="bg-white rounded-md px-2 py-1.5 border border-emerald-200">
          <p className="text-[7px] font-black text-emerald-500 uppercase tracking-wider mb-0.5">
           Clear Key
          </p>
          <p className="text-[10px] font-mono font-bold text-emerald-700 break-all">
           {moduleClearKey || '(không có)'}
          </p>
         </div>
        </div>
       </div>
      )}
     </div>
    );
  })()} */}
 </div>
 );
 })()}

 {/* 3. BỘ SƯU TẬP HÌNH ẢNH NGOẠI QUAN */}
 {(() => {
 const allPhotos: { url: string; label: string }[] = [];
 const seenUrls = new Set<string>();
 const addPhoto = (url: string, label: string) => { if (url && !seenUrls.has(url)) { seenUrls.add(url); allPhotos.push({ url, label }); } };

 const instances = getModuleInstances(matchedEntry);
 const stageFields = [
  { field: "qcWhite" as const, lbl: "T" },
  { field: "qcPaint" as const, lbl: "S" },
  { field: "qcFinish" as const, lbl: "H" },
  { field: "qcPack" as const, lbl: "Đ" },
 ];

 if (instanceIndex != null && instances.length > 0) {
  // Xem instance cụ thể → chỉ lấy ảnh QC của instance đó
  const targetInst = instances.find(inst => inst.instanceIndex === instanceIndex);
  if (targetInst) {
   stageFields.forEach(({ field, lbl }) => {
    const qcData = (targetInst as any)[field];
    if (qcData && qcData.status !== "fail" && qcData.photos?.length) {
     qcData.photos.forEach((p: string) => addPhoto(p, `${lbl} - #${instanceIndex}`));
    }
   });
  }
  // Packing photos cho instance cụ thể (đã được filter bởi effect query)
  if (packingPhotos.length) {
   packingPhotos.forEach((p) => addPhoto(p.url, `Gói - #${instanceIndex}`));
  }
 } else if (instances.length > 0) {
  // Không chọn instance → lấy ảnh QC từ tất cả instances
  instances.forEach(inst => {
   stageFields.forEach(({ field, lbl }) => {
    const qcData = (inst as any)[field];
    if (qcData && qcData.status !== "fail" && qcData.photos?.length) {
     qcData.photos.forEach((p: string) => addPhoto(p, `${lbl} - #${inst.instanceIndex || 1}`));
    }
   });
  });
  // Packing photos cho tất cả
  if (packingPhotos.length) {
   packingPhotos.forEach((p) => addPhoto(p.url, `Gói${p.instanceIndex != null ? ` - #${p.instanceIndex}` : ''}`));
  }
 } else {
  // Không có instances → fallback root-level QC
  stageFields.forEach(({ field, lbl }) => {
   const data = matchedEntry[field];
   if (data && data.status !== "fail" && data.photos?.length) {
    data.photos.forEach((p: string) => addPhoto(p, lbl));
   }
  });
  if (packingPhotos.length) {
   packingPhotos.forEach((p) => addPhoto(p.url, `Gói${p.instanceIndex != null ? ` - #${p.instanceIndex}` : ''}`));
  }
 }

 if (!allPhotos.length) return null;
 const urls = allPhotos.map((p) => p.url);

 return (
 <div className="space-y-3 pt-3 border-t border-slate-100 font-sans text-left bg-slate-100/20 p-4 rounded-lg border border-slate-100"> <h4 className="text-[9.5px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
  <span className="w-1.5 h-1.5 bg-indigo-500 mr-2 rounded-full"></span>
  {t('Hình ảnh ngoại quan thực tế')} ({allPhotos.length})
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
 (document.getElementById("mobile-photo-dialog") as HTMLDialogElement)?.showModal();
 }}
 >
 <img
 src={img.url}
 alt={img.label}
 referrerPolicy="no-referrer"
 className="w-full h-full object-cover"
 loading="lazy"
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

 {/* 4. TÌNH TRẠNG KIỂM ĐỊNH (4 CÔNG ĐOẠN) */}
 {instanceIndex != null ? (
  // Khi mở instance cụ thể: hiển thị QC badge cho instance đó
  <QcStageBadges
   module={matchedEntry}
   instance={getModuleInstances(matchedEntry).find(inst => inst.instanceIndex === instanceIndex)}
   qcTickets={[]}
   isQC={hasRole('admin') || hasRole('qc') || hasRole('mod_dg')}
   canEditQc={hasRole('admin') || hasRole('mod_dg')}
   packStatus={getModuleInstances(matchedEntry).find(inst => inst.instanceIndex === instanceIndex)?.packStatus}
   canOpenPacking={hasRole('admin') || hasRole('mod_dg') || (hasRole('mod_x2') && ((userProfile?.chuc_danh || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('dg')))}
   onOpenPacking={onOpenPacking}
  />
 ) : (
  // Khi mở module: hiển thị QC từng instance
  (() => {
   const instances = getModuleInstances(matchedEntry);
   if (instances.length === 0) {
    return <QcStageBadges module={matchedEntry} qcTickets={[]} isQC={hasRole('admin') || hasRole('qc') || hasRole('mod_dg')} canEditQc={hasRole('admin') || hasRole('mod_dg')} canOpenPacking={hasRole('admin') || hasRole('mod_dg') || (hasRole('mod_x2') && ((userProfile?.chuc_danh || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('dg')))} onOpenPacking={onOpenPacking} />;
   }
   const stageFields = [
    { field: 'qcWhite', label: 'Trắng', short: 'T' },
    { field: 'qcPaint', label: 'Sơn', short: 'S' },
    { field: 'qcFinish', label: 'Hoàn thiện', short: 'H' },
    { field: 'qcPack', label: 'Đóng gói', short: 'Đ' },
   ];
   return (
    <div className="space-y-2 pt-2">
  <h4 className="text-[9.5px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
   <span className="w-1.5 h-1.5 bg-indigo-500 mr-2 rounded-full"></span>
   {t('Tình trạng QC từng kiện')} ({instances.length} {t('Kiện')})
  </h4>
     <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-center min-w-[400px]">
       <thead>
        <tr className="bg-slate-100 border-b border-slate-200">
         <th className="px-2 py-1.5 text-[8px] font-black text-slate-500 uppercase tracking-wider text-left">{t('Kiện')}</th>
         {stageFields.map(s => (
          <th key={s.field} className="px-2 py-1.5 text-[8px] font-black text-slate-500 uppercase tracking-wider">{s.short}</th>
         ))}
        </tr>
       </thead>
       <tbody className="divide-y divide-slate-100">
        {instances.map((inst) => {
         const recQty = matchedEntry.receivedQuantity || 0;
         const isDelivered = recQty >= (inst.instanceIndex || 0);
         return (
          <tr key={inst.instanceIndex} className={`${isDelivered ? 'bg-emerald-100/30' : 'bg-white'} hover:bg-indigo-100/30 transition-colors`}>
           <td className="px-2 py-1.5 text-left">
            <span className="text-[10px] font-black text-slate-700">#{inst.instanceIndex}</span>
            <span className={`ml-1.5 text-[7px] font-bold px-1 py-0.5 rounded-sm ${isDelivered ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
             {isDelivered ? t('Đã nhận') : t('Chờ')}
            </span>
           </td>
           {stageFields.map(s => {
            const qcData = (inst as any)[s.field];
            const status = qcData?.status || 'none';
            const bg = status === 'pass' ? 'bg-emerald-100 text-emerald-700' : status === 'fail' ? 'bg-rose-100 text-rose-700' : status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400';
            const label = status === 'pass' ? '✓' : status === 'fail' ? '✗' : status === 'pending' ? '…' : '—';
            return (
             <td key={s.field} className="px-2 py-1.5">
              <span className={`inline-flex items-center justify-center w-6 h-6 rounded-lg text-[9px] font-black ${bg}`} title={qcData?.by ? `${status.toUpperCase()} by ${qcData.by}` : status}>
               {label}
              </span>
             </td>
            );
           })}
          </tr>
         );
        })}
       </tbody>
      </table>
     </div>
    </div>
   );
  })()
 )}

 {/* THÔNG TIN LÊN HÀNG */}
 {instanceIndex != null && matchedEntry && (() => {
  const inst = getModuleInstances(matchedEntry).find(i => i.instanceIndex === instanceIndex);
  if (!inst?.loadInfo) return null;
  const li = inst.loadInfo;
  return (
   <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
  <h4 className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.2em] flex items-center mb-3">
   <Truck size={12} className="mr-2" />
   {t('Thông tin lên hàng')}
  </h4>
    <div className="grid grid-cols-2 gap-3 text-xs">
     <div>
      <span className="text-[10px] font-bold text-slate-400 uppercase">{t('Mã PKL')}</span>
      <p className="font-mono font-bold text-slate-700 mt-0.5">{li.pklCode}</p>
     </div>
     <div>
      <span className="text-[10px] font-bold text-slate-400 uppercase">{t('Thời gian')}</span>
      <p className="font-bold text-slate-700 mt-0.5">
       {li.loadedAt?.toDate?.()?.toLocaleString('vi-VN') || 'N/A'}
      </p>
     </div>
     <div>
      <span className="text-[10px] font-bold text-slate-400 uppercase">{t('Người xếp')}</span>
      <p className="font-bold text-slate-700 mt-0.5">{li.loadedBy}</p>
     </div>
     {li.vehicleInfo && (
      <div>
       <span className="text-[10px] font-bold text-slate-400 uppercase">{t('Phương tiện')}</span>
       <p className="font-bold text-slate-700 mt-0.5">{li.vehicleInfo}</p>
      </div>
     )}
    </div>
   </div>
  );
 })()}

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
 <div className=""> <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center mb-4">
  <span className="w-1.5 h-1.5 bg-indigo-500 mr-2 rounded-full "></span>
  {t('Danh sách cấu kiện con')}
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
 if (onOpenModule) {
 onOpenModule(child);
 }
 }}
 className="flex items-center justify-between p-2.5 bg-slate-100 rounded-lg border border-slate-200 hover:border-indigo-500 transition-all cursor-pointer group"
 >
 <div className="flex flex-col min-w-0">
 <span className="text-[11px] font-black uppercase text-slate-800 truncate group-hover:text-indigo-600 leading-tight">
 {
 child.moduleCode
 }
 </span>
 <span className="text-[8px] font-bold text-slate-400 truncate uppercase mt-0.5 leading-none">  {child.classification ||
  t('Cấu kiện con')}
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
 {/* 5. PHỤ KIỆN ĐÍNH KÈM */}
 {matchedEntry.accessories &&
 matchedEntry.accessories.length > 0 && (
 <div className="space-y-2.5">  <h4 className="text-[9.5px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
  <span className="w-1.5 h-1.5 bg-orange-500 mr-2 rounded-full"></span>
  {t('Phụ kiện đi kèm')} (
  {
  matchedEntry.accessories
  .length
  }
  )
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

 {/* 6. NHẬT KÝ CẬP NHẬT HỆ THỐNG */}
 <div className="space-y-3 pt-3 border-t border-slate-100 font-sans">  <h4 className="text-[9.5px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
  <span className="w-1.5 h-1.5 bg-teal-500 mr-2 rounded-full"></span>
  {t('Nhật ký lịch sử cấu kiện')}
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
 />  <p className="text-[8.5px] font-black uppercase tracking-widest">
  {t('Không có lịch sử')}
  </p>
  <p className="text-[8.5px] text-slate-400">
  {t('Hệ thống chưa ghi nhận các hoạt động thay đổi cấu kiện này.')}
  </p>
 </div>
 )}
 </div>
 </div>


 )}
 </>
 )}
 {result.notes && (
 <div className="p-3 bg-indigo-100 rounded-lg border border-indigo-100 flex gap-3 italic shadow-sm shrink-0">
 <Info size={16} className="text-indigo-600 shrink-0" />
 <p className="text-[10px] text-indigo-805 leading-tight font-bold uppercase tracking-tight">
 {result.notes}
 </p>
 </div>
 )}
 </div>

 {/* Footer */}
 <div className="p-4 pb-20 md:pb-4 bg-slate-100 border-t border-slate-200 flex items-center justify-end shrink-0">
 <div className="flex items-center gap-3">
 <button
 type="button"
 onClick={onClose}
 className="px-5 py-2.5 bg-white text-slate-800 border border-slate-200 rounded-lg text-[10px] font-black uppercase tracking-widest shadow-sm hover:bg-slate-100 transition-all active:scale-95 leading-none cursor-pointer"
 >  {t('Đóng cửa sổ')}
 </button>
 </div>
 </div>
 </motion.div>

 <dialog id="mobile-photo-dialog" className="m-auto bg-transparent p-0 backdrop:bg-black/90 backdrop:backdrop-blur-md rounded-lg max-w-4xl w-full outline-none" onClick={(e) => { if (e.target === e.currentTarget) (e.target as HTMLDialogElement).close(); }}>
 <div className="flex flex-col items-center">
 <div className="w-full flex items-center justify-between text-white p-2">
 <span className="text-xs font-black uppercase tracking-wider font-mono">{lightboxStartIndex + 1} / {lightboxImages.length}</span>
 <button onClick={() => (document.getElementById('mobile-photo-dialog') as HTMLDialogElement)?.close()} className="p-2 hover:bg-white/10 rounded-full transition-all text-gray-300 hover:text-white cursor-pointer"><X size={24} /></button>
 </div>
 <div className="relative w-full flex items-center justify-center p-2">
 {lightboxImages.length > 1 && (
 <button onClick={() => setLightboxStartIndex((prev) => (prev - 1 + lightboxImages.length) % lightboxImages.length)} className="absolute left-2 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 z-20 cursor-pointer"><ChevronLeft size={28} /></button>
 )}
 {lightboxImages[lightboxStartIndex] && <img key={lightboxStartIndex} src={lightboxImages[lightboxStartIndex]} className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl" />}
 {lightboxImages.length > 1 && (
 <button onClick={() => setLightboxStartIndex((prev) => (prev + 1) % lightboxImages.length)} className="absolute right-2 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 z-20 cursor-pointer"><ChevronRight size={28} /></button>
 )}
 </div>
 {lightboxImages.length > 1 && (
 <div className="flex gap-2 max-w-[85vw] overflow-x-auto py-2 px-4 bg-black/40 backdrop-blur-sm rounded-full border border-white/5 custom-scrollbar">
 {lightboxImages.map((img, i) => (
 <img key={i} src={img} className={`w-9 h-9 object-cover rounded-md cursor-pointer border transition-all ${i === lightboxStartIndex ? 'border-indigo-500 scale-105 ring-2 ring-indigo-500/30' : 'border-white/10 opacity-60 hover:opacity-100'}`} onClick={() => setLightboxStartIndex(i)} />
 ))}
 </div>
 )}
 </div>
 </dialog>
 </div>
 );
 },
);
ModuleDetailModal.displayName = "ModuleDetailModal";
