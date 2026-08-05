import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { addProjectAccessory, findProjectConfigId } from '../../lib/dualWrite';
import { useAuth } from '../../lib/AuthContext';
import { ProjectEntry } from '../../types';

interface AddProjectAccessoryModalProps {
 projectCode: string | null;
 projectEntries: ProjectEntry[];
 onClose: () => void;
}

export function AddProjectAccessoryModal({ projectCode, projectEntries, onClose }: AddProjectAccessoryModalProps) {
 const { user } = useAuth();
 const [name, setName] = useState('');
 const [quantity, setQuantity] = useState(1);
 const [loading, setLoading] = useState(false);

 const handleAdd = async () => {
 if (!user || !projectCode || !name.trim()) return;
 setLoading(true);
 try {
 const pName = projectEntries[0]?.projectName || projectCode;
 const cleanName = name.toUpperCase().trim();
 
 const newAccessoryDoc = {
 projectName: pName,
 projectCode,
 moduleCode: `PK-${cleanName}`,
 name: cleanName,
 classification: 'Phụ kiện' as any,
 quantity: 1,
 accessories: [{
 name: cleanName,
 quantity: quantity,
 issuedQuantity: 0,
 status: 'Chưa xuất kho'
 }],
 createdAt: serverTimestamp(),
 ownerId: user.uid
 };

 const configId = await findProjectConfigId(projectCode);
 if (configId) {
 await addProjectAccessory(configId, newAccessoryDoc);
 } else {
 await addDoc(collection(db, 'projectConfigs', projectCode, 'modules'), newAccessoryDoc);
 }

 await addDoc(collection(db, 'activities'), {
 userId: user.uid, userName: user.displayName || 'Anonymous', userEmail: user.email,
 action: 'Thêm phụ kiện dự án', details: `Thêm PK độc lập ${cleanName} (Tổng số lượng ${quantity}) vào dự án ${projectCode}`,
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
 <div className="p-4 border-b border-slate-100 bg-white">
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">Thêm Phụ Kiện Dự Án</h3>
 </div>
 <div className="p-6 space-y-6">
 <div className="bg-amber-100 p-4 rounded-lg border border-amber-100">
 <p className="text-[11px] text-amber-800 font-bold uppercase tracking-tight leading-relaxed italic">Phụ kiện này sẽ được khai báo độc lập với các cấu kiện/module của dự án.</p>
 </div>
 <div className="space-y-4">
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Tên Loại Phụ Kiện</label>
 <input className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-slate-900 focus:border-indigo-600 outline-none transition-all uppercase placeholder:italic" value={name} onChange={e => setName(e.target.value)} placeholder="VD: ỐC VÍT, RAY TRƯỢT..." />
 </div>
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Tổng Số Lượng Phụ Kiện Cho Dự Án</label>
 <input type="number" min={1} className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-indigo-600 outline-none focus:border-indigo-600 transition-all font-mono" value={quantity} onChange={e => setQuantity(Number(e.target.value))} />
 </div>
 </div>
 </div>
 <div className="flex bg-slate-100 border-t border-slate-100 p-4 space-x-3">
 <button onClick={onClose} className="px-6 py-2.5 bg-white text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest border border-slate-200 hover:bg-slate-100 transition-all">Huỷ</button>
 <button disabled={loading || !name} onClick={handleAdd} className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-[11px] font-black uppercase tracking-widest transition-all shadow-xl shadow-amber-100 disabled:opacity-100 flex items-center justify-center space-x-2">
 {loading ? <Loader2 size={16} className="animate-spin" /> : <span>Xác nhận thiết lập</span>}
 </button>
 </div>
 </motion.div>
 </div>
 );
}
