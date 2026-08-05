import React, { useState } from 'react';
import { motion } from 'motion/react';
import { X, Copy, Check, Share2, ExternalLink } from 'lucide-react';

interface ShareProjectModalProps {
  projectName: string;
  projectCode: string;
  shareLink: string;
  onClose: () => void;
}

export function ShareProjectModal({ projectName, projectCode, shareLink, onClose }: ShareProjectModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select input text
      const input = document.getElementById('share-link-input') as HTMLInputElement;
      if (input) {
        input.select();
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Dự án ${projectCode}`,
          text: `Xem dự án ${projectName} (${projectCode})`,
          url: shareLink,
        });
      } catch {}
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-slate-200"
      >
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Share2 size={16} className="text-indigo-600" />
            <h3 className="text-base font-black text-indigo-600 uppercase tracking-tight">Chia sẻ dự án</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="bg-indigo-100 p-4 rounded-lg border border-indigo-100">
            <p className="text-[12px] font-bold text-indigo-700 leading-relaxed">
              Gửi link bên dưới cho khách để họ xem dự án{' '}
              <span className="font-black underline decoration-2 underline-offset-4">{projectCode}</span>.
            </p>
            <p className="text-[11px] text-indigo-500 mt-1">
              Khách chỉ cần đăng nhập Google — không cần cấp quyền.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Liên kết chia sẻ</label>
            <div className="flex items-stretch gap-2">
              <input
                id="share-link-input"
                readOnly
                value={shareLink}
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2.5 text-xs font-mono text-slate-600 bg-slate-100 outline-none select-all"
              />
              <button
                onClick={handleCopy}
                className={`shrink-0 px-4 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${
                  copied
                    ? 'bg-emerald-600 text-white'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                }`}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Đã copy' : 'Copy'}
              </button>
            </div>
          </div>

          {navigator.share && (
            <button
              onClick={handleNativeShare}
              className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 border border-slate-200"
            >
              <ExternalLink size={14} />
              Chia sẻ qua ứng dụng
            </button>
          )}
        </div>

        <div className="flex bg-slate-100 border-t border-slate-100 p-4">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 bg-white text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest border border-slate-200 hover:bg-slate-50 transition-all"
          >
            Đóng
          </button>
        </div>
      </motion.div>
    </div>
  );
}
