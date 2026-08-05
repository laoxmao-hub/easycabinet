/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion } from 'motion/react';
import { X, Save, Loader2, User, LogOut, AlertTriangle } from 'lucide-react';
import { doc, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { UserProfile } from '../types';
import { useAuth } from '../lib/AuthContext';
import { useLanguage } from '../lib/LanguageContext';

export function UserProfileModal({
  profile,
  isGuest,
  onClose
}: {
  profile: UserProfile,
  isGuest?: boolean,
  onClose: () => void
}) {
  const { logout } = useAuth();
  const { t } = useLanguage();
  const [tenThat, setTenThat] = useState(profile.ten_that || '');
  const [chucDanh, setChucDanh] = useState(profile.chuc_danh || '');
  const [loading, setLoading] = useState(false);
  const [showConfirmLogout, setShowConfirmLogout] = useState(false);

  const handleSave = async () => {
    setLoading(true);
    try {
      const userRef = doc(db, 'users', profile.uid);
      await updateDoc(userRef, {
        ten_that: tenThat,
        chuc_danh: chucDanh
      });
      onClose();
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'users');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      setLoading(true);
      await logout();
      onClose();
    } catch (error) {
      console.error("Logout error", error);
    } finally {
      setLoading(false);
    }
  };

  const displayName = isGuest ? (profile.name || t('Khách')) : (profile.displayName || profile.ten_that || '');
  const displayEmail = isGuest ? (profile.phone || profile.email || '') : (profile.email || '');

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white w-full max-w-sm rounded-lg shadow-2xl overflow-hidden flex flex-col border border-slate-200"
      >
        <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-slate-100 text-slate-800 rounded-lg flex items-center justify-center border border-slate-100">
              <User size={22} />
            </div>
            <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">{t('Thông tin cá nhân')}</h3>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-rose-500 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-8 space-y-8">
          <div className="flex flex-col items-center space-y-4">
            <div className="relative">
              {profile.photoURL ? (
                <img
                  src={profile.photoURL}
                  alt={displayName}
                  referrerPolicy="no-referrer"
                  className="w-24 h-24 rounded-2xl border-4 border-white shadow-xl object-cover"
                />
              ) : (
                <div className="w-24 h-24 rounded-2xl border-4 border-white shadow-xl bg-slate-100 flex items-center justify-center text-slate-300">
                  <User size={40} />
                </div>
              )}
              <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-emerald-500 border-4 border-white rounded-full"></div>
            </div>

            <div className="text-center">
              <h4 className="text-lg font-black text-slate-900 uppercase tracking-tight">{displayName}</h4>
              {displayEmail && (
                <p className="text-[11px] text-slate-400 font-bold uppercase tracking-widest mt-1">{displayEmail}</p>
              )}
              {isGuest && (
                <p className="text-[10px] text-indigo-500 font-black uppercase tracking-widest mt-1">{t('Khách hàng')}</p>
              )}
            </div>
          </div>

          {!isGuest && (
            <div className="grid grid-cols-1 gap-6">
              <div className="space-y-2.5">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none px-1">{t('Họ & Tên thật')}</label>
                <input
                  className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-slate-900 focus:border-indigo-600 outline-none transition-all shadow-none uppercase"
                  placeholder="VD: Nguyễn Văn A"
                  value={tenThat}
                  onChange={e => setTenThat(e.target.value)}
                />
              </div>
              <div className="space-y-2.5">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none px-1">{t('Chức danh / Vị trí')}</label>
                <input
                  className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-slate-900 focus:border-indigo-600 outline-none transition-all shadow-none uppercase"
                  placeholder="VD: Trưởng phòng kỹ thuật"
                  value={chucDanh}
                  onChange={e => setChucDanh(e.target.value)}
                />
              </div>
            </div>
          )}

          {isGuest && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-3 bg-indigo-50 border border-indigo-100 rounded-lg">
                <User size={14} className="text-indigo-500 shrink-0" />
                <p className="text-xs text-indigo-600 font-medium">
                  {t('Bạn đang đăng nhập với tư cách khách hàng. Nhấn nút "Thoát" bên dưới để đăng xuất.')}
                </p>
              </div>
            </div>
          )}
        </div>

        {showConfirmLogout ? (
          <div className="bg-rose-100 border-t border-rose-100 p-5 space-y-3">
            <div className="flex items-center space-x-2 text-rose-600">
              <AlertTriangle size={18} />
              <span className="text-xs font-black uppercase tracking-tight">{t('Xác nhận thoát tài khoản?')}</span>
            </div>
            <div className="flex space-x-3">
              <button
                type="button"
                onClick={() => setShowConfirmLogout(false)}
                className="flex-1 py-2.5 px-4 text-slate-500 font-black text-[10px] uppercase border border-slate-200 bg-white rounded-lg transition-all cursor-pointer"
              >
                {t('Hủy')}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={handleLogout}
                className="flex-1 py-2.5 px-4 bg-rose-600 hover:bg-rose-700 text-white font-black text-[10px] uppercase rounded-lg transition-all flex items-center justify-center space-x-2 cursor-pointer"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
                <span>{t('Đồng ý')}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex bg-slate-100 border-t border-slate-100 p-5 space-x-3">
            <button
              type="button"
              onClick={() => setShowConfirmLogout(true)}
              className="flex-1 py-3 px-4 text-rose-500 font-black text-[10px] uppercase border border-rose-100 bg-rose-100 hover:bg-rose-100 rounded-lg transition-all flex items-center justify-center space-x-2 tracking-widest cursor-pointer"
            >
              <LogOut size={16} />
              <span>{t('Thoát')}</span>
            </button>

            {!isGuest && (
              <button
                type="button"
                disabled={loading}
                onClick={handleSave}
                className="flex-[1.5] py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase tracking-widest text-[11px] shadow-xl shadow-indigo-100 transition-all flex items-center justify-center space-x-2 disabled:opacity-100 rounded-lg cursor-pointer"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : (
                  <>
                    <Save size={16} />
                    <span>{t('Lưu thông tin')}</span>
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}
