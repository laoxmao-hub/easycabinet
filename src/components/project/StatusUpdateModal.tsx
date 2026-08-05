import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { doc, writeBatch, collection, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { updateProjectModule } from '../../lib/dualWrite';
import { useAuth } from '../../lib/AuthContext';
import { ProjectEntry } from '../../types';
import { PHASES } from '../../constants';

interface StatusUpdateModalProps {
 onClose: () => void;
 entries: ProjectEntry[];
 preSelectedIds: string[];
}

export function StatusUpdateModal({ onClose, entries, preSelectedIds }: StatusUpdateModalProps) {
 const { user, userProfile } = useAuth();
 const [loading, setLoading] = useState(false);
 const selectedEntries = entries.filter(e => preSelectedIds.includes(e.id));
 const [selectedPhase, setSelectedPhase] = useState('Giao Nhận');
 const [selectedStatus, setSelectedStatus] = useState(PHASES['Giao Nhận'][0]);

 const handleUpdate = async () => {
 if (!user || selectedEntries.length === 0) return;
 setLoading(true);
 try {
 const batch = writeBatch(db);
 const fullStatus = `${selectedPhase} - ${selectedStatus}`;
 const logRef = doc(collection(db, 'activities'));

 const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');

 batch.set(logRef, {
 userId: user.uid, userName: displayLabel, userEmail: user.email,
 action: 'Cập nhật trạng thái', details: `Cập nhật ${selectedEntries.length} module lên: ${fullStatus}`,
 projectCode: selectedEntries[0]?.projectCode, timestamp: serverTimestamp()
 });

 await batch.commit();

 for (const entry of selectedEntries) {
 const history = [...(entry.statusHistory || [])];
 const entryWithTime = `${fullStatus}|${Date.now()}`;
 const lastEntryHash = history.length > 0 ? history[history.length - 1].split('|')[0] : null;
 if (lastEntryHash !== fullStatus) {
 history.push(entryWithTime);
 await updateProjectModule(entry.id, { status: fullStatus, statusHistory: history }, entry.projectCode);
 } else {
 await updateProjectModule(entry.id, { status: fullStatus }, entry.projectCode);
 }
 }
 onClose();
 } catch (err) {
 handleFirestoreError(err, OperationType.UPDATE, 'projects');
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
 <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-full max-w-sm rounded-lg shadow-2xl overflow-hidden border border-slate-200">
 <div className="p-4 border-b border-slate-100 bg-white">
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">Cập nhật {selectedEntries.length} Module</h3>
 </div>
 <div className="p-6 space-y-6">
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Chọn Công Đoạn</label>
 <select className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-2.5 text-sm font-black text-slate-800 focus:border-indigo-600 outline-none transition-all uppercase" value={selectedPhase} onChange={e => { setSelectedPhase(e.target.value); setSelectedStatus(PHASES[e.target.value][0]); }}>
 {Object.keys(PHASES).map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
 </select>
 </div>
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Trạng Thái Chi Tiết</label>
 <select className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-2.5 text-sm font-black text-slate-800 focus:border-indigo-600 outline-none transition-all uppercase" value={selectedStatus} onChange={e => setSelectedStatus(e.target.value)}>
 {PHASES[selectedPhase].map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}
 </select>
 </div>
 </div>
 <div className="flex bg-slate-100 border-t border-slate-100 p-4 space-x-3">
 <button onClick={onClose} className="px-6 py-2.5 bg-white text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest border border-slate-200 hover:bg-slate-100 transition-all">Huỷ</button>
 <button disabled={loading} onClick={handleUpdate} className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-black uppercase tracking-widest transition-all shadow-xl shadow-emerald-100 disabled:opacity-100 flex items-center justify-center space-x-2">
 {loading ? <Loader2 size={16} className="animate-spin" /> : <span>Lưu cập nhật</span>}
 </button>
 </div>
 </motion.div>
 </div>
 );
}
