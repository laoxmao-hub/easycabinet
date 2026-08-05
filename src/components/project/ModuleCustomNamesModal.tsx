import React, { useState, useMemo } from 'react';
import { X, Save, Loader2, Tag, Boxes, Layers, RotateCw, Info, Hash, Search } from 'lucide-react';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../lib/AuthContext';
import { useLanguage } from '../../lib/LanguageContext';
import { ProjectEntry } from '../../types';
import { updateProjectModule } from '../../lib/dualWrite';
import { MatchLogEntry } from './ModuleThreeViewer';

interface ModuleCustomNamesModalProps {
 entry: ProjectEntry;
 onClose: () => void;
 onSaved?: () => void;
 matchLogs?: MatchLogEntry[];
}

/**
 * Modal chỉnh sửa tên hiển thị, tên object và key cụm.
 * Layout 2 cột: trái = form, phải = match log (faded/clear/hidden).
 */
export function ModuleCustomNamesModal({
 entry,
 onClose,
 onSaved,
 matchLogs = [],
}: ModuleCustomNamesModalProps) {
 const { user } = useAuth();
 const { t } = useLanguage();
 const [displayName, setDisplayName] = useState(entry.displayName || '');
 const [objectName, setObjectName] = useState(entry.objectName || '');
 const [objectClusterName, setObjectClusterName] = useState(
  entry.objectClusterName || '',
 );
 const [cameraAngle, setCameraAngle] = useState<string>(
  entry.cameraAngle != null ? String(entry.cameraAngle) : '',
 );
 const [saving, setSaving] = useState(false);
 const [logSearch, setLogSearch] = useState('');

 const handleSave = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!user) return;
  setSaving(true);
  try {
   const updateData: Record<string, any> = {
    displayName: displayName.trim(),
    objectName: objectName.trim(),
    objectClusterName: objectClusterName.trim(),
   };
   (['displayName', 'objectName', 'objectClusterName'] as const).forEach(
    (key) => {
     if (!updateData[key]) {
      updateData[key] = null;
     }
    },
   );
   const angleParsed = parseFloat(cameraAngle);
   updateData.cameraAngle =
    cameraAngle.trim() === '' || isNaN(angleParsed)
     ? null
     : Math.min(360, Math.max(0, angleParsed));

   await updateProjectModule(entry.id, updateData, entry.projectCode);

   await addDoc(collection(db, 'activities'), {
    userId: user.uid,
    userName: user.displayName || 'Anonymous',
    userEmail: user.email,
    action: 'Chỉnh tên hiển thị / Object 3D',
    details: `Cập nhật tên hiển thị, tên object, key cụm cho module ${entry.moduleCode} (${entry.projectCode})`,
    projectCode: entry.projectCode,
    moduleCode: entry.moduleCode,
    timestamp: serverTimestamp(),
   });

   onSaved?.();
   onClose();
  } catch (error) {
   console.error('Lỗi lưu tên module:', error);
   handleFirestoreError(error, OperationType.UPDATE, 'projects');
  } finally {
   setSaving(false);
  }
 };

 const inputCls =
  'w-full px-3 py-2 text-[12px] font-bold text-slate-800 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all placeholder:text-slate-300';

 // Match log stats
 const visibleLogs = matchLogs.filter((l) => l.state !== 'hidden');
 const clearLogs = visibleLogs.filter((l) => l.state === 'clear');
 const fadedLogs = visibleLogs.filter((l) => l.state === 'faded');
 const hiddenLogs = matchLogs.filter((l) => l.state === 'hidden');

 // Get fadedKey and clearKey from first log entry (same for all)
 const moduleFadedKey = matchLogs[0]?.fadedKey || '';
 const moduleClearKey = matchLogs[0]?.clearKey || '';

 // Filter logs by search
 const filteredLogs = useMemo(() => {
  if (!logSearch.trim()) return matchLogs;
  const q = logSearch.toLowerCase();
  return matchLogs.filter(
   (l) =>
    l.name.toLowerCase().includes(q) ||
    (l.matchedKey && l.matchedKey.toLowerCase().includes(q)) ||
    l.state.toLowerCase().includes(q)
  );
 }, [matchLogs, logSearch]);

 return (
  <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[220] p-2 sm:p-4 backdrop-blur-sm">
   <div className="absolute inset-0" onClick={onClose} />
   <div className="bg-white w-full max-w-4xl lg:max-w-5xl max-h-[92vh] rounded-lg shadow-2xl overflow-hidden flex flex-col border border-slate-200 relative z-10">
    {/* Header */}
    <div className="px-5 py-4 border-b border-slate-100 bg-white flex items-center justify-between shrink-0">
     <div className="flex items-center space-x-3 min-w-0">
      <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center border border-indigo-100 shrink-0">
       <Tag size={18} />
      </div>
      <div className="min-w-0">
       <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight leading-none mb-1 truncate">
        {t('Chỉnh tên module')}
       </h3>
       <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest leading-none truncate">
        {entry.moduleCode}
       </p>
      </div>
     </div>
     <button
      type="button"
      onClick={onClose}
      className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-100 rounded-lg transition-all shrink-0 cursor-pointer"
     >
      <X size={18} />
     </button>
    </div>

    {/* Body: 2 columns */}
    <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">
     {/* LEFT: Form */}
     <form onSubmit={handleSave} className="lg:w-[45%] p-5 space-y-4 overflow-y-auto border-r border-slate-200">
      {/* Tên module */}
      <div>
       <label className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">
        <Tag size={11} />
        {t('Tên module')}
       </label>
       <div className="w-full px-3 py-2 text-[12px] font-bold text-slate-400 bg-slate-100 border border-slate-200 rounded-lg font-mono">
        {entry.moduleCode}
       </div>
       <p className="text-[9px] text-slate-400 mt-1">
        {t('Tên module gốc — không thể chỉnh sửa')}
       </p>
      </div>

      {/* Tên hiển thị */}
      <div>
       <label className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">
        <Tag size={11} className="text-indigo-500" />
        {t('Tên hiển thị')}
       </label>
       <input
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder={entry.moduleCode}
        className={inputCls}
       />
       <p className="text-[9px] text-slate-400 mt-1">
        {t('Hiển thị thay cho tên module trong danh sách module')}
       </p>
      </div>

      {/* Tên object = Clear Key (có thể nhiều) */}
      <div>
       <label className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">
        <Boxes size={11} className="text-emerald-500" />
        {t('Clear Key (Tên object)')}
       </label>
       <textarea
        value={objectName}
        onChange={(e) => setObjectName(e.target.value)}
        placeholder={entry.moduleCode}
        className={inputCls + ' min-h-[60px] resize-y'}
        rows={2}
       />
       <p className="text-[9px] text-slate-400 mt-1">
        {t('Nhiêu key phân tách bằng dấu phẩy. Dùng để khớp clear key trong mô hình 3D')}
       </p>
      </div>

      {/* Key cụm = Faded Key (có thể nhiều) */}
      <div>
       <label className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">
        <Layers size={11} className="text-amber-500" />
        {t('Faded Key (Key cụm)')}
       </label>
       <textarea
        value={objectClusterName}
        onChange={(e) => setObjectClusterName(e.target.value)}
        placeholder={entry.cluster || ''}
        className={inputCls + ' min-h-[60px] resize-y'}
        rows={2}
       />
       <p className="text-[9px] text-slate-400 mt-1">
        {t('Nhiều key phân tách bằng dấu phẩy. Dùng để khớp faded key trong mô hình 3D')}
       </p>
      </div>

      {/* Góc camera */}
      <div>
       <label className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">
        <RotateCw size={11} className="text-indigo-500" />
        {t('Góc camera')}
       </label>
       <div className="flex items-center gap-2">
        <input
         type="number"
         min={0}
         max={360}
         step={5}
         value={cameraAngle}
         onChange={(e) => setCameraAngle(e.target.value)}
         placeholder="0"
         className={inputCls}
        />
        <span className="text-[10px] font-black text-slate-400 shrink-0">°</span>
       </div>
       <p className="text-[9px] text-slate-400 mt-1">
        {t(
         'Độ 0-360: 0° = góc mặc định, +90° = quay camera theo chiều kim đồng hồ nhìn từ trên',
        )}
       </p>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
       <button
        type="button"
        onClick={onClose}
        className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all cursor-pointer"
       >
        {t('Hủy')}
       </button>
       <button
        type="submit"
        disabled={saving}
        className="flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-all active:scale-95 cursor-pointer disabled:opacity-60"
       >
        {saving ? (
         <Loader2 size={12} className="animate-spin" />
        ) : (
         <Save size={12} />
        )}
        {t('Lưu')}
       </button>
      </div>
     </form>

     {/* RIGHT: Match Log */}
     <div className="lg:w-[55%] flex flex-col overflow-hidden bg-slate-50">
      {/* Header + Module Keys */}
      <div className="p-4 border-b border-slate-200 space-y-3">
       <div className="flex items-center justify-between">
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
         <Info size={12} className="text-indigo-500" />
         Object Match Log
        </span>
        {matchLogs.length > 0 && (
         <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-black text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-lg">
           {clearLogs.length} Clear
          </span>
          <span className="text-[10px] font-black text-amber-600 bg-amber-100 px-2 py-0.5 rounded-lg">
           {fadedLogs.length} Faded
          </span>
          <span className="text-[10px] font-black text-slate-500 bg-slate-100 px-2 py-0.5 rounded-lg">
           {hiddenLogs.length} Hidden
          </span>
         </div>
        )}
       </div>

       {/* Module Key Display */}
       {(moduleFadedKey || moduleClearKey) && (
        <div className="bg-gradient-to-r from-amber-50 to-emerald-50 border border-slate-200 rounded-lg p-3">
         <p className="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-2">
          Key của module <span className="text-indigo-600">{entry.moduleCode}</span>
         </p>
         <div className="grid grid-cols-2 gap-2">
          <div className="bg-white rounded-lg px-3 py-2 border border-amber-200">
           <p className="text-[8px] font-black text-amber-500 uppercase tracking-wider mb-0.5">
            <Hash size={8} className="inline" /> Faded Key
           </p>
           <p className="text-[11px] font-mono font-bold text-amber-700 break-all">
            {moduleFadedKey || '(không có)'}
           </p>
           <p className="text-[8px] text-amber-500 mt-0.5">
            Match prefix → hiển thị mờ
           </p>
          </div>
          <div className="bg-white rounded-lg px-3 py-2 border border-emerald-200">
           <p className="text-[8px] font-black text-emerald-500 uppercase tracking-wider mb-0.5">
            <Hash size={8} className="inline" /> Clear Key
           </p>
           <p className="text-[11px] font-mono font-bold text-emerald-700 break-all">
            {moduleClearKey || '(không có)'}
           </p>
           <p className="text-[8px] text-emerald-500 mt-0.5">
            = Faded + Clear → hiển thị rõ
           </p>
          </div>
         </div>
         {/* Formula explanation */}
         <div className="mt-2 pt-2 border-t border-slate-200">
          <p className="text-[8px] text-slate-500">
           <span className="font-bold">Công thức:</span> Clear Key = Faded Key + Clear Part
          </p>
          <p className="text-[8px] text-slate-400 mt-0.5">
           Ví dụ: Faded=<span className="font-bold text-amber-600">MOD</span> + Clear=<span className="font-bold text-emerald-600">G1</span> → <span className="font-bold text-indigo-600">MODG1</span>
          </p>
         </div>
        </div>
       )}

       {/* Search */}
       <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
         type="text"
         value={logSearch}
         onChange={(e) => setLogSearch(e.target.value)}
         placeholder="Tìm theo tên object, key, hoặc state..."
         className="w-full pl-8 pr-3 py-1.5 text-[10px] font-medium text-slate-700 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
        />
       </div>
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto p-4">
       {filteredLogs.length === 0 ? (
        <div className="text-center py-8 text-slate-300">
         <Info size={24} className="mx-auto mb-2 text-slate-300" />
         <p className="text-[10px] font-bold uppercase">
          {matchLogs.length === 0 ? 'Chưa có dữ liệu match log' : 'Không tìm thấy kết quả'}
         </p>
        </div>
       ) : (
        <div className="space-y-1">
         {filteredLogs.map((log, i) => (
          <div
           key={i}
           className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-white transition-colors"
          >
           <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
             log.state === 'clear'
              ? 'bg-emerald-500'
              : log.state === 'faded'
                ? 'bg-amber-400'
                : 'bg-slate-300'
            }`}
           ></span>
           <span
            className={`text-[10px] font-mono flex-1 truncate ${
             log.state === 'hidden' ? 'text-slate-400' : 'text-slate-700'
            }`}
            title={log.name}
           >
            {log.name}
           </span>
           {log.matchedKey && (
            <span className="text-[9px] font-mono text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded shrink-0 flex items-center gap-0.5 border border-indigo-100" title={`Key used: ${log.matchedKey}`}>
             <Hash size={9} />
             {log.matchedKey}
            </span>
           )}
           <span
            className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded-sm shrink-0 ${
             log.state === 'clear'
              ? 'bg-emerald-100 text-emerald-700'
              : log.state === 'faded'
                ? 'bg-amber-100 text-amber-700'
                : 'bg-slate-100 text-slate-500'
            }`}
           >
            {log.state}
           </span>
          </div>
         ))}
        </div>
       )}
      </div>
     </div>
    </div>
   </div>
  </div>
 );
}
