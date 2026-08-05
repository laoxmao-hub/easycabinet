import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Pencil, Trash2, Loader2, AlertCircle, X } from 'lucide-react';
import { query, collection, where, getDocs, writeBatch, addDoc, serverTimestamp, doc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../lib/AuthContext';

interface AccessoryUpdateModalProps {
 accessoryName: string;
 totalRequired: number;
 currentIssued: number;
 currentStatus: string;
 projectCode: string | null;
 onClose: () => void;
}

export function AccessoryUpdateModal({ accessoryName, totalRequired, currentIssued, currentStatus, projectCode, onClose }: AccessoryUpdateModalProps) {
 const { user } = useAuth();
 const [newName, setNewName] = useState(accessoryName);
 const [issuedValue, setIssuedValue] = useState(currentIssued);
 const [status, setStatus] = useState(currentStatus || 'Chưa xuất kho');
 const [loading, setLoading] = useState(false);
 const [isDeleting, setIsDeleting] = useState(false);
 const [showEditName, setShowEditName] = useState(false);

 const handleDelete = async () => {
 if (!user || !projectCode) return;
 if (!confirm(`Bạn có chắc chắn muốn XÓA phụ kiện "${accessoryName}" khỏi TẤT CẢ các module trong dự án này? Thao tác này không thể hoàn tác.`)) return;

 setLoading(true);
 try {
 const snap = await getDocs(collection(db, 'projectConfigs', projectCode, 'modules'));
  const batch = writeBatch(db);

  snap.docs.forEach(docSnap => {
  const data = docSnap.data();
  const accessories = (data.accessories || []).filter((a: any) => a.name !== accessoryName);
  batch.update(docSnap.ref, { accessories });
  });

 await batch.commit();
 await addDoc(collection(db, 'activities'), {
 userId: user.uid, userName: user.displayName || 'Anonymous', userEmail: user.email,
 action: 'Xóa phụ kiện dự án', details: `Xóa PK ${accessoryName} khỏi dự án ${projectCode}`,
 projectCode, timestamp: serverTimestamp()
 });
 onClose();
 } catch (e: any) {
 handleFirestoreError(e, OperationType.DELETE, 'projects');
 } finally {
 setLoading(false);
 }
 };

 const handleUpdate = async () => {
 if (!user || !projectCode) return;
 setLoading(true);
 try {
 const snap = await getDocs(collection(db, 'projectConfigs', projectCode, 'modules'));
  const batch = writeBatch(db);

  let remainingToUpdate = issuedValue;
 snap.docs.forEach(docSnap => {
 const data = docSnap.data();
 let accessories = [...(data.accessories || [])];
 let changed = false;

 accessories = accessories.map(a => {
 if (a.name === accessoryName) {
 changed = true;
 const take = Math.min(remainingToUpdate, a.quantity);
 remainingToUpdate -= take;
 // Also update name if changed
 return { ...a, name: newName, issuedQuantity: take, status: status };
 }
 return a;
 });
 if (changed) batch.update(docSnap.ref, { accessories });
 });

 await batch.commit();

 const detailsStr = newName !== accessoryName 
 ? `Đổi tên PK ${accessoryName} -> ${newName} & Cập nhật: Xuất ${issuedValue}/${totalRequired} (${status})`
 : `PK ${accessoryName}: Xuất ${issuedValue}/${totalRequired} (${status})`;

 await addDoc(collection(db, 'activities'), {
 userId: user.uid, userName: user.displayName || 'Anonymous', userEmail: user.email,
 action: 'Cập nhật phụ kiện bộ', details: detailsStr,
 projectCode, timestamp: serverTimestamp()
 });
 onClose();
 } catch (e: any) {
 handleFirestoreError(e, OperationType.UPDATE, 'projects');
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
 <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-full max-w-sm rounded-lg shadow-2xl overflow-hidden border border-slate-200">
 <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-white">
 <div className="flex-1 min-w-0 pr-4">
 {showEditName ? (
 <div className="flex items-center gap-2">
 <input 
 type="text" 
 autoFocus
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-3 py-1.5 text-sm font-black outline-none focus:border-indigo-600 uppercase transition-all"
 value={newName}
 onChange={(e) => setNewName(e.target.value)}
 />
 <button onClick={() => setShowEditName(false)} className="p-1.5 bg-rose-100 text-rose-600 rounded-lg border border-rose-100"><X size={16}/></button>
 </div>
 ) : (
 <div className="flex items-center gap-2">
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight truncate">{newName}</h3>
 <button onClick={() => setShowEditName(true)} className="p-1 text-slate-400 hover:text-indigo-600 transition-colors"><Pencil size={14}/></button>
 </div>
 )}
 <p className="text-[9px] text-slate-400 font-black uppercase tracking-[0.2em] mt-1 line-clamp-1">Dự án: {projectCode}</p>
 </div>
 <button onClick={handleDelete} className="p-2.5 bg-rose-100 text-rose-400 hover:text-rose-600 rounded-lg border border-rose-100 transition-all" title="Xóa phụ kiện">
 <Trash2 size={18} />
 </button>
 </div>
 <div className="p-6 space-y-6">
 {newName !== accessoryName && (
 <div className="bg-indigo-100 border border-indigo-100 p-3 rounded-lg flex items-center gap-3 text-[10px] text-indigo-700 font-black uppercase tracking-tight shadow-sm">
 <AlertCircle size={14} className="shrink-0" />
 <span>Tên PK sẽ được thay đổi trên toàn bộ dự án</span>
 </div>
 )}
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">
 Số lượng đã xuất (Tổng {totalRequired})
 </label>

 <div className="relative">
 <input type="number" max={totalRequired} className="w-full border border-slate-200 rounded-lg pl-4 pr-16 py-3 text-sm font-black text-indigo-600 focus:border-indigo-600 outline-none bg-slate-100 transition-all font-mono shadow-none" value={issuedValue} onChange={(e) => setIssuedValue(Number(e.target.value))} />
 <button type="button" onClick={() => setIssuedValue(totalRequired)} className="absolute right-2 top-1/2 -translate-y-1/2 px-2.5 py-1 text-[9px] font-black uppercase bg-white text-slate-600 border border-slate-200 rounded-md hover:bg-slate-100 transition-all shadow-sm" >
 ALL
 </button>
 </div>
 </div>
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Trạng thái vật tư / Cung ứng</label>
 <select className="w-full border border-slate-200 rounded-lg px-4 py-3 text-sm font-black text-slate-800 focus:border-indigo-600 outline-none bg-slate-100 transition-all uppercase tracking-tight shadow-none" value={status} onChange={e => setStatus(e.target.value)}>
 <option value="Chưa xuất kho">Chưa xuất kho</option>
 <option value="Chưa có hàng">Chưa có hàng</option>
 <option value="Chờ đặt hàng">Chờ đặt hàng</option>
 <option value="Xuất kho lắp ráp">Lắp ráp (X2)</option>
 <option value="Xuất kho đóng gói">Đóng gói (X2)</option>
 <option value="Xưởng 1 xuất">Xưởng 1 cấp</option>
 </select>
 </div>
 </div>
 <div className="flex bg-slate-100 border-t border-slate-100 p-4 space-x-3">
 <button onClick={onClose} className="px-6 py-2.5 bg-white text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest border border-slate-200 hover:bg-slate-100 transition-all">Huỷ</button>
 <button disabled={loading} onClick={handleUpdate} className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[11px] font-black uppercase tracking-widest transition-all shadow-xl shadow-indigo-100 disabled:opacity-100 flex items-center justify-center space-x-2">
 {loading ? <Loader2 size={16} className="animate-spin" /> : <span>Lưu thay đổi bộ</span>}
 </button>
 </div>
 </motion.div>
 </div>
 );
}
