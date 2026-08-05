import React from 'react';
import { ProjectEntry, getModuleQcAggregate } from '../types';

interface QcStageBadgesProps {
 module: ProjectEntry;
 instance?: any;
 qcTickets?: any[];
 onStageClick?: (stageId: string) => void;
 onOpenPacking?: (instanceIndex?: number) => void;
 isPacked?: boolean;
 packStatus?: string;
 isQC?: boolean;
 showLabel?: boolean;
 compact?: boolean;
 canOpenPacking?: boolean; // Chỉ admin hoặc mod_x2 DG Leader mới có quyền bấm
 canEditQc?: boolean; // Cho phép mod_qc chỉnh sửa giai đoạn đã QC
 stages?: readonly { id: string; label: string; short: string }[];
 label?: string;
}

const STAGES = [
 { id: 'white', label: 'Hàng Trắng', short: 'T' },
 { id: 'paint', label: 'Hàng Sơn', short: 'S' },
 { id: 'finish', label: 'Hoàn Thiện', short: 'H' },
 { id: 'pack', label: 'Đóng Gói', short: 'Đ' },
 ] as const;

function isModuleInTicket(moduleId: string, moduleCode: string, stageId: string, qcTickets: any[]) {
 return qcTickets.some(t =>
  t.stage === stageId && t.status === 'pending' &&
  (t.modules || []).some((m: any) =>
   (m.id === moduleId || m.moduleCode === moduleCode) &&
   m.status !== 'pass' && m.status !== 'fail'
  )
 );
}

export function QcStageBadges({ module, instance, qcTickets = [], onStageClick, onOpenPacking, isPacked = false, packStatus, isQC = false, showLabel = true, compact = false, canOpenPacking = false, canEditQc = false, stages, label }: QcStageBadgesProps) {
 const activeStages = stages || STAGES;
 return (
  <div className="space-y-3 pt-2 text-left">
   {showLabel && (
   <h4 className="text-[9.5px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
    <span className="w-1.5 h-1.5 bg-indigo-500 mr-2 rounded-full"></span>
    {label || "Tình trạng giám sát QC các công đoạn"}
   </h4>
   )}

   <div className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${activeStages.length}, minmax(0, 1fr))` }}>
    {activeStages.map((stage) => {
     const field = `qc${stage.id.charAt(0).toUpperCase() + stage.id.slice(1)}`;
     const qcData = instance ? instance[field] : getModuleQcAggregate(module, stage.id as any);
     const inTicket = isModuleInTicket(module.id, module.moduleCode, stage.id, qcTickets);
     const effectiveStatus = qcData?.status || (inTicket ? 'pending' : 'none');

     const isPass = effectiveStatus === 'pass';
     const isFail = effectiveStatus === 'fail';
     const isPending = effectiveStatus === 'pending';

     let containerClass = 'bg-slate-100 border-slate-200 text-slate-400';
     let textClass = 'text-slate-400';

     if (isPass) {
      containerClass = 'bg-emerald-100 border-emerald-300 text-emerald-800 shadow-sm';
      textClass = 'text-emerald-700 font-extrabold';
     } else if (isFail) {
      containerClass = 'bg-rose-100 border-rose-300 text-rose-800 shadow-sm';
      textClass = 'text-rose-700 font-extrabold';
     } else if (isPending) {
      containerClass = isQC
       ? 'bg-amber-100 border-amber-200 text-amber-700 animate-pulse cursor-pointer hover:bg-amber-100/70 shadow-sm'
       : 'bg-amber-100/50 border-amber-200 text-amber-700 shadow-sm';
      textClass = 'text-amber-700 font-extrabold';
     }

     // Xử lý đặc biệt cho giai đoạn đóng gói
     const isPackStage = stage.id === 'pack';
     let packLabel = '';
     if (isPackStage) {
      if (packStatus === 'pending') {
       packLabel = 'CẦN ĐÓNG';
      } else if (packStatus === 'done' || isPacked) {
       packLabel = 'CẦN KIỂM';
      }
     }

     const isPackPending = isPackStage && packStatus === 'pending';
     const isPackDone = isPackStage && (packStatus === 'done' || isPacked);

     let finalContainerClass = containerClass;
     let finalTextClass = textClass;
     if (isPackPending) {
      finalContainerClass = canOpenPacking
       ? 'bg-blue-100 border-blue-300 text-blue-700 shadow-sm cursor-pointer hover:shadow-md hover:bg-blue-200/50 animate-pulse'
       : 'bg-blue-100/50 border-blue-200 text-blue-700 shadow-sm';
      finalTextClass = 'text-blue-700 font-extrabold';
     } else if (isPackDone) {
      finalContainerClass = canOpenPacking
       ? 'bg-amber-100 border-amber-300 text-amber-700 shadow-sm cursor-pointer hover:shadow-md hover:bg-amber-200/50 animate-pulse'
       : 'bg-amber-100 border-amber-200 text-amber-700 shadow-sm';
      finalTextClass = 'text-amber-700 font-extrabold';
     }

     // Xác định có thể bấm vào badge này không
     const canClick = onStageClick && (
      (canEditQc && isPending) || // Chờ kiểm → chỉ admin/mod_qc bấm được
      (canEditQc && (isPass || isFail)) // mod_qc chỉnh sửa giai đoạn đã pass/fail
     );

     // Style cho các badge có thể bấm (admin/mod_qc)
     if (canClick && !isPackStage) {
      if (isPass) {
       finalContainerClass = 'bg-emerald-100 border-emerald-300 text-emerald-800 shadow-sm cursor-pointer hover:shadow-md hover:bg-emerald-200/50';
      } else if (isFail) {
       finalContainerClass = 'bg-rose-100 border-rose-300 text-rose-800 shadow-sm cursor-pointer hover:shadow-md hover:bg-rose-200/50';
      } else if (isPending) {
       finalContainerClass = 'bg-amber-100 border-amber-200 text-amber-700 animate-pulse cursor-pointer hover:bg-amber-100/70 shadow-sm';
      }
     }

     return (
      <div
       key={stage.id}
       onClick={
        isPackDone && onStageClick ? () => onStageClick('pack') :
        isPackPending && canOpenPacking && onOpenPacking ? () => onOpenPacking(instance?.instanceIndex) :
        canClick ? () => onStageClick(stage.id) : undefined
       }
       className={`rounded-lg border flex flex-col items-center justify-between text-center gap-1.5 transition-all select-none ${compact ? 'p-2' : 'p-3'} ${finalContainerClass} ${(isPackPending || isPackDone) && canOpenPacking ? 'hover:shadow-md' : ''} ${canClick && !isPackStage ? 'hover:shadow-md' : ''}`}
      >
       <div className="flex flex-col items-center gap-1 w-full flex-1 justify-center">
        <span className="text-[7px] md:text-[8px] font-black uppercase tracking-widest text-slate-400 block truncate w-full">
         {stage.label}
        </span>
        <div className={`text-[9.5px] md:text-[10px] font-black uppercase px-2 py-0.5 rounded-lg tracking-wider ${finalTextClass}`}>
         {packLabel || (isPass ? 'ĐẠT' : isFail ? 'LỖI' : isPending ? (isQC ? 'CẦN KIỂM' : 'CHỜ KIỂM') : 'TRỐNG')}
        </div>
        {qcData?.by ? (
         <span className="text-[7.5px] font-bold text-slate-500 uppercase truncate w-full px-0.5 leading-none mt-0.5 block">
          {qcData.by}
         </span>
        ) : (
         <span className="text-[7px] font-medium text-slate-300 truncate w-full italic block">--</span>
        )}
       </div>
      </div>
     );
    })}
   </div>
  </div>
 );
}
