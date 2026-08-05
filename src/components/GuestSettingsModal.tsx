import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Settings, Globe, Ruler, X } from 'lucide-react';
import { useLanguage } from '../lib/LanguageContext';

interface GuestSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function GuestSettingsModal({ isOpen, onClose }: GuestSettingsModalProps) {
  const { lang, setLang, unit, setUnit, t } = useLanguage();

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/40"
          onClick={onClose}
        >
          <motion.div
            initial={{ y: '100%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="bg-white w-full max-w-lg rounded-t-2xl sm:rounded-2xl border-t sm:border border-slate-200 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Handle bar (mobile) */}
            <div className="flex justify-center pt-3 pb-1 sm:hidden">
              <div className="w-10 h-1 bg-slate-300 rounded-full" />
            </div>

            <div className="px-5 py-5 sm:p-6">
              {/* Header */}
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2">
                  <Settings size={18} className="text-indigo-600" />
                  <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight">
                    {lang === 'vi' ? 'Cài đặt' : 'Settings'}
                  </h3>
                </div>
                <button
                  onClick={onClose}
                  className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer sm:hidden"
                >
                  <X size={16} className="text-slate-400" />
                </button>
              </div>

              {/* Language */}
              <div className="mb-5">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2.5 flex items-center gap-1.5">
                  <Globe size={12} />
                  {lang === 'vi' ? 'Ngôn ngữ' : 'Language'}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setLang('en')}
                    className={`py-3 rounded-lg text-sm font-black uppercase tracking-tight transition-all border cursor-pointer ${
                      lang === 'en'
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-500/20'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    🇬🇧 English
                  </button>
                  <button
                    onClick={() => setLang('vi')}
                    className={`py-3 rounded-lg text-sm font-black uppercase tracking-tight transition-all border cursor-pointer ${
                      lang === 'vi'
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-500/20'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    🇻🇳 Tiếng Việt
                  </button>
                </div>
              </div>

              {/* Unit */}
              <div className="mb-6">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2.5 flex items-center gap-1.5">
                  <Ruler size={12} />
                  {lang === 'vi' ? 'Đơn vị' : 'Unit'}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setUnit('mm')}
                    className={`py-3 rounded-lg text-sm font-black uppercase tracking-tight transition-all border cursor-pointer ${
                      unit === 'mm'
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-500/20'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    📏 mm
                  </button>
                  <button
                    onClick={() => setUnit('inch')}
                    className={`py-3 rounded-lg text-sm font-black uppercase tracking-tight transition-all border cursor-pointer ${
                      unit === 'inch'
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-500/20'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    📐 inch
                  </button>
                </div>
              </div>

              {/* Close button (desktop) */}
              <button
                onClick={onClose}
                className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all border border-slate-200 cursor-pointer hidden sm:block"
              >
                {lang === 'vi' ? 'Đóng' : 'Close'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
