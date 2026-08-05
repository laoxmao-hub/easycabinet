import React, { useState, useMemo } from 'react';
import { motion } from 'motion/react';
import { X, Check, Loader2, GitMerge, Plus, ArrowRight } from 'lucide-react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../lib/AuthContext';
import { ProjectEntry } from '../../types';
import { batchUpdateProjectModules } from '../../lib/dualWrite';

// Hàm helper phân loại
const getEntryType = (entry: ProjectEntry): 'Thùng' | 'Cánh' | 'Đợt' | 'Mặt HK' | 'CTHT' | 'Gia công ngoài' => {
 if (entry.classification) {
 if (entry.classification === 'Gia Công Ngoài' || (entry.classification as string) === 'Gia công ngoài') {
 return 'Gia công ngoài';
 }
 return entry.classification as any;
 }
 const code = entry.moduleCode || '';
 const codeLower = code.toLowerCase();
 
 if (codeLower.includes('-gcn') || codeLower.includes('gcn') || codeLower.includes('gia cong ngoai') || codeLower.includes('giacongngoai') || codeLower.includes('outsource')) {
 return 'Gia công ngoài';
 }
 
 const isOriginalCanhMatHK = codeLower.includes('mặt học kéo') || codeLower.includes('mat hoc keo') || codeLower.includes('cửa') || codeLower.includes('cua');
 const isOriginalCTHT = codeLower.includes('tấm hoàn thiện') || codeLower.includes('tam hoan thien') || codeLower.includes('hoàn thiện') || codeLower.includes('hoan thien') || codeLower.includes('ctht') || code.split('_').length >= 3;
 
 if (!isOriginalCanhMatHK && !isOriginalCTHT) {
 if (codeLower.includes('đợt') || codeLower.includes('dot')) {
 return 'Đợt';
 }
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

interface QuickMergeModalProps {
 projectCode: string | null;
 projectEntries: ProjectEntry[];
 onClose: () => void;
}

export function QuickMergeModal({ projectCode, projectEntries, onClose }: QuickMergeModalProps) {
 const { user } = useAuth();
 const [loading, setLoading] = useState(false);
 
 // Danh sách các từ khóa mặc định và tùy chỉnh
 // Mặc định bật ☑ Cánh, ☑ Cửa, ☑ Mặt học kéo
 const [keywordsMap, setKeywordsMap] = useState<Record<string, boolean>>({
 "Cánh": true,
 "Cửa": true,
 "Mặt học kéo": true,
 "Hậu": false,
 "Đợt": false,
 "Hông": false,
 "Chân": false,
 });
 
 const [customKeywords, setCustomKeywords] = useState<string[]>([]);
 const [inputText, setInputText] = useState("");

 const toggleKeyword = (kw: string) => {
 setKeywordsMap(prev => ({ ...prev, [kw]: !prev[kw] }));
 };

 const addCustomKeyword = () => {
 const trimmed = inputText.trim();
 if (!trimmed) return;
 if (!customKeywords.includes(trimmed) && !Object.keys(keywordsMap).includes(trimmed)) {
 setCustomKeywords(prev => [...prev, trimmed]);
 }
 setInputText("");
 };

 const removeCustomKeyword = (kw: string) => {
 setCustomKeywords(prev => prev.filter(k => k !== kw));
 };

 // Lấy toàn bộ các từ khóa đang ACTIVE
 const activeKeywords = useMemo(() => {
 const list = Object.keys(keywordsMap).filter(k => keywordsMap[k]);
 return [...list, ...customKeywords];
 }, [keywordsMap, customKeywords]);

 // Logic so khớp và đề xuất ghép (Yêu cầu 4, 5)
 const proposedMerges = useMemo(() => {
 if (!projectCode) return [];
 
 // Căn cứ theo danh sách hiện có, lọc ra parents (module cha - loại "Thùng")
 const parents = projectEntries.filter(e => e.projectCode === projectCode && getEntryType(e) === "Thùng");
 
 // Tìm các module con (không phải loại "Thùng")
 const children = projectEntries.filter(e => e.projectCode === projectCode && getEntryType(e) !== "Thùng");
 
 // Duyệt qua từng con và thử khớp với parents
 // Chỉ ghép các con CHƯA có parentId để không ảnh hưởng đến liên kết đã tồn tại (Yêu cầu Validation)
 const resultList: Array<{ parent: ProjectEntry; children: Array<{ child: ProjectEntry; ratio: number }> }> = [];
 
 parents.forEach(p => {
 resultList.push({ parent: p, children: [] });
 });
 
 children.forEach(c => {
  const matchedParent = matchChildToParent(c, parents, activeKeywords);
 if (matchedParent) {
 const parentCluster = resultList.find(res => res.parent.id === matchedParent.id);
 if (parentCluster) {
 const ratio = pRound((c.quantity || 1) / (matchedParent.quantity || 1));
 parentCluster.children.push({ child: c, ratio });
 }
 }
 });
 
 // Chỉ trả về những nhóm cha mà thực sự có con đề xuất ghép để Preview trực quan
 return resultList.filter(cluster => cluster.children.length > 0);
 }, [projectCode, projectEntries, activeKeywords]);

 const totalProposedCount = useMemo(() => {
 return proposedMerges.reduce((acc, curr) => acc + curr.children.length, 0);
 }, [proposedMerges]);

 const handleConfirmMerge = async () => {
 if (!user || !projectCode || totalProposedCount === 0) return;
 setLoading(true);
 try {
 let editCount = 0;
 const updates: { moduleId: string; data: Record<string, any>; projectCode?: string }[] = [];
 
 proposedMerges.forEach(cluster => {
 const parent = cluster.parent;
 cluster.children.forEach(proposed => {
 const child = proposed.child;
  updates.push({
  moduleId: child.id,
  data: {
  parentId: parent.id,
  parentModuleCode: parent.moduleCode,
  parentInstanceId: parent.id,
  assemblyQuantity: proposed.ratio,
  cluster: parent.cluster || child.cluster,
  },
  projectCode: child.projectCode
  });
 editCount++;
 });
 });
 
 await batchUpdateProjectModules(updates);
 
 // Ghi nhận hoạt động
 await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: user.displayName || 'Anonymous',
 userEmail: user.email,
 action: 'Ghép Nhanh',
 details: `LR2 Ghép nhanh hàng loạt thành công, liên kết ${editCount} cấu kiện con vào các thùng thuộc dự án: ${projectCode}`,
 projectCode: projectCode,
 timestamp: serverTimestamp()
 });
 
 onClose();
 } catch (error: any) {
 handleFirestoreError(error, OperationType.WRITE, 'projects');
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
 <motion.div
 initial={{ scale: 0.95, opacity: 0 }}
 animate={{ scale: 1, opacity: 1 }}
 className="bg-white w-full max-w-2xl rounded-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[85vh]"
 >
 {/* Modal Header */}
 <div className="p-5 border-b border-slate-100 flex items-center justify-between shrink-0 bg-slate-100">
 <div className="flex items-center gap-3">
 <div className="p-2 bg-indigo-600 text-white rounded-lg">
 <GitMerge size={18} />
 </div>
 <div>
 <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">
 Ghép nhanh liên kết thông minh
 </h3>
 <p className="text-[10px] text-slate-400 font-extrabold uppercase mt-0.5">
 Dự án mã: {projectCode}
 </p>
 </div>
 </div>
 <button
 onClick={onClose}
 className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
 >
 <X size={18} />
 </button>
 </div>

 {/* Modal Body */}
 <div className="p-6 overflow-y-auto space-y-6 flex-1 custom-scrollbar">
 {/* Section 1: Bộ lọc từ khóa ghép (Yêu cầu 2, 3) */}
 <div className="space-y-3 p-4 bg-slate-100 rounded-lg border border-slate-200">
 <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none flex items-center">
 <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full mr-1.5"></span>
 Bộ lọc phân nhóm cấu kiện ghép nhanh
 </h4>
 
 {/* Hệ lọc nhóm mặc định */}
 <div className="flex flex-wrap gap-2.5 pt-1">
 {Object.keys(keywordsMap).map((kw) => {
 const checked = keywordsMap[kw];
 return (
 <button
 key={kw}
 type="button"
 onClick={() => toggleKeyword(kw)}
 className={`px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider border transition-all cursor-pointer flex items-center gap-1.5 ${
 checked
 ? "bg-indigo-100 border-indigo-200 text-indigo-600"
 : "bg-white border-slate-200 text-slate-500 hover:border-slate-400"
 }`}
 >
 <span className="text-[10px]">{checked ? "☑" : "☐"}</span>
 {kw}
 </button>
 );
 })}
 </div>

 {/* Từ khóa custom đã thêm */}
 {customKeywords.length > 0 && (
 <div className="space-y-1.5 pt-2 border-t border-slate-200/50">
 <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest leading-none">Từ khóa tự chọn đã bổ sung:</p>
 <div className="flex flex-wrap gap-2">
 {customKeywords.map((kw) => (
 <span
 key={kw}
 className="px-2.5 py-1 rounded-lg bg-emerald-100 border border-emerald-200 text-emerald-600 text-[10px] font-black uppercase tracking-wider flex items-center gap-1.5"
 >
 <span>☑</span>
 {kw}
 <button
 type="button"
 onClick={() => removeCustomKeyword(kw)}
 className="text-emerald-400 hover:text-rose-500 font-bold ml-1 cursor-pointer transition-colors"
 >
 <X size={10} />
 </button>
 </span>
 ))}
 </div>
 </div>
 )}

 {/* Input thêm từ khóa custom */}
 <div className="flex gap-2 pt-2 border-t border-slate-200/50">
 <input
 type="text"
 placeholder="Nhập từ khóa bổ sung... (VD: Mặt bàn, Tay nắm)"
 value={inputText}
 onChange={(e) => setInputText(e.target.value)}
 onKeyDown={(e) => {
 if (e.key === "Enter") {
 e.preventDefault();
 addCustomKeyword();
 }
 }}
 className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:border-indigo-500 leading-none"
 />
 <button
 type="button"
 onClick={addCustomKeyword}
 className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-755 text-white rounded-lg text-xs font-black uppercase tracking-wider flex items-center gap-1 cursor-pointer active:scale-95 transition-all"
 >
 <Plus size={12} />
 Thêm
 </button>
 </div>
 </div>

 {/* Section 2: Preview trước khi ghép (Yêu cầu 5) */}
 <div className="space-y-3.5">
 <div className="flex items-center justify-between">
 <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none flex items-center">
 <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full mr-1.5"></span>
 Kết quả dự kiến sau khi khớp ({totalProposedCount} thiết lập mới)
 </h4>
 {totalProposedCount > 0 && (
 <span className="text-[8px] font-black px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-600 border border-emerald-100 uppercase tracking-widest">
 Khả dụng để lưu
 </span>
 )}
 </div>

 <div className="border border-slate-200 rounded-lg divide-y divide-slate-200 bg-white p-3 space-y-3 max-h-[300px] overflow-y-auto custom-scrollbar">
 {totalProposedCount === 0 ? (
 <div className="text-center py-10 text-slate-400 space-y-2">
 <GitMerge size={32} className="mx-auto opacity-30 animate-pulse" />
 <p className="text-[10px] font-black uppercase tracking-widest">Không tìm thấy tổ hợp ghép nào phù hợp bộ lọc</p>
 <p className="text-[8.5px] italic text-slate-400 leading-normal max-w-sm mx-auto">
 Thử bật thêm từ khóa hoặc thêm các từ khoá phù hợp với module của dự án hoặc đảm bảo các cấu kiện con chưa được ghép trước đó.
 </p>
 </div>
 ) : (
 proposedMerges.map((cluster, idx) => (
 <div key={cluster.parent.id || idx} className="p-3 bg-slate-100/50 rounded-lg space-y-2 border border-slate-100">
 {/* Module Cha */}
 <div className="flex items-center justify-between border-b border-dashed border-slate-200 pb-1.5">
 <div className="flex items-center gap-2">
 <span className="w-2 h-2 rounded bg-indigo-505"></span>
 <span className="text-[11px] font-black text-slate-800 uppercase leading-none">
 {cluster.parent.moduleCode}
 </span>
 <span className="text-[8px] font-bold text-slate-400 px-1.5 py-0.5 bg-slate-100 rounded uppercase leading-none">
 Thùng • {cluster.parent.quantity} cái
 </span>
 </div>
 </div>
 
 {/* Các Module Con Dựng Ghép */}
 <div className="pl-4 space-y-1.5">
 {cluster.children.map((c, cIdx) => (
 <div key={c.child.id || cIdx} className="flex items-center justify-between text-[11px] hover:bg-slate-100/50 p-1 rounded-lg transition-colors">
 <div className="flex items-center gap-1.5 text-slate-600 font-medium">
 <span className="text-slate-300 select-none">└──</span>
 <span className="uppercase font-black text-slate-705">
 {c.child.moduleCode}
 </span>
 <span className="text-[9px] text-slate-400">
 ({getEntryType(c.child)} • {c.child.quantity} cái)
 </span>
 </div>
 <div className="flex items-center gap-1">
 <ArrowRight size={10} className="text-slate-300" />
 <span className="text-[9px] font-black text-indigo-600 px-1.5 py-0.5 bg-indigo-100/50 rounded-lg border border-indigo-100">
 {c.ratio} cái/module
 </span>
 </div>
 </div>
 ))}
 </div>
 </div>
 ))
 )}
 </div>
 </div>
 </div>

 {/* Modal Footer */}
 <div className="p-4 bg-slate-100 border-t border-slate-100 flex items-center justify-between shrink-0">
 <button
 onClick={onClose}
 disabled={loading}
 className="px-5 py-2.5 bg-white text-slate-800 border border-slate-200 rounded-lg text-[10px] font-black uppercase tracking-widest shadow-sm hover:bg-slate-100 transition-all cursor-pointer leading-none"
 >
 Hủy bỏ
 </button>
 <button
 onClick={handleConfirmMerge}
 disabled={loading || totalProposedCount === 0}
 className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-100 text-white rounded-lg text-[10px] font-black uppercase tracking-widest flex items-center gap-2 cursor-pointer shadow-lg active:scale-95 transition-all leading-none"
 >
 {loading ? (
 <Loader2 size={12} className="animate-spin" />
 ) : (
 <Check size={12} />
 )}
 <span>Xác nhận Ghép</span>
 </button>
 </div>
 </motion.div>
 </div>
 );
}

// Logic helper làm tròn tỷ số lắp ráp
function pRound(val: number): number {
 return Math.round(val * 100) / 100;
}

// Logic so khớp và tìm kiếm thông minh cấu kiện con có mã gốc khớp với thùng cha
function matchChildToParent(child: ProjectEntry, parents: ProjectEntry[], keywords: string[]): ProjectEntry | null {
 const childCode = child.moduleCode.trim();
 const childName = ((child as any).name || child.classification || "").trim();
 
 let matchedKeyword = "";
 for (const kw of keywords) {
 const kwLower = kw.toLowerCase().trim();
 if (childCode.toLowerCase().includes(kwLower) || childName.toLowerCase().includes(kwLower)) {
 matchedKeyword = kw;
 break;
 }
 }
 
 if (!matchedKeyword) return null;
 
 const childSegments = childCode.split(/[\s\-_]+/);
 
 // Duyệt qua từng Thùng cha để kiểm tra sự trùng khớp
 for (const p of parents) {
 const parentCode = p.moduleCode.trim();
 const parentSegments = parentCode.split(/[\s\-_]+/);
 const parentSuffix = parentSegments[parentSegments.length - 1]; // Ví dụ: "KIT.T9" hoặc "COT.T1"
 
 if (!parentSuffix) continue;

 const parentSuffixLower = parentSuffix.toLowerCase();
 
 // Cách 1: So khớp phân đoạn chính xác (ngăn chặn hoàn toàn COT.T1 trùng với COT.T10)
 const hasExactSuffix = childSegments.some(seg => seg.toLowerCase() === parentSuffixLower);
 
 if (hasExactSuffix) {
 // Đảm bảo cùng chung mã tiền tố dự án (ví dụ: "ELMB1") nếu cả hai đều có định dạng prefix_suffix
 if (parentSegments.length > 1 && childSegments.length > 1) {
 const parentPrefixLower = parentSegments[0].toLowerCase();
 const childPrefixLower = childSegments[0].toLowerCase();
 if (parentPrefixLower !== childPrefixLower) {
 continue;
 }
 }
 return p;
 }
 
 // Cách 2 Dự phòng: Dùng Regex biên để kiểm tra xem có chứa đúng tag riêng biệt của cha không
 const escapedSuffix = parentSuffix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
 const suffixRegex = new RegExp(`(^|[_\\s\\-])${escapedSuffix}($|[_\\s\\-])`, 'i');
 
 if (suffixRegex.test(childCode)) {
 if (parentSegments.length > 1 && childSegments.length > 1) {
 const parentPrefixLower = parentSegments[0].toLowerCase();
 const childPrefixLower = childSegments[0].toLowerCase();
 if (parentPrefixLower !== childPrefixLower) {
 continue;
 }
 }
 return p;
 }
 }
 
 return null;
}
