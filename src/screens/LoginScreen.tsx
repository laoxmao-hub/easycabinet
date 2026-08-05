/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { LogIn, UserRound, KeyRound, Loader2, AlertCircle, Globe } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { useLanguage } from '../lib/LanguageContext';
import { signInAnonymously, signOut } from 'firebase/auth';
import { auth, db } from '../lib/firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';

export function LoginScreen() {
  const { login, customerLoginError, onAnonymousReady } = useAuth();
  const { t, lang, setLang } = useLanguage();
  const [loginId, setLoginId] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  useEffect(() => {
    if (customerLoginError) setLoginLoading(false);
  }, [customerLoginError]);

  const handleCustomerLogin = async () => {
    if (!loginId.trim() || !loginPass.trim()) return;
    setLoginLoading(true);
    setLoginError('');

    try {
      // Sign in anonymously first to get Firestore access
      const cred = await signInAnonymously(auth);

      // Query customers by loginId
      const q = query(collection(db, 'customers'), where('loginId', '==', loginId.trim()));
      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        setLoginError(t('ID không tồn tại.'));
        localStorage.removeItem('customerLogin');
        await signOut(auth);
        setLoginLoading(false);
        return;
      }

      const customerDoc = snapshot.docs[0];
      const customerData = customerDoc.data();

      // Verify password
      if (customerData.loginPass !== loginPass.trim()) {
        setLoginError(t('Mật khẩu không đúng.'));
        localStorage.removeItem('customerLogin');
        await signOut(auth);
        setLoginLoading(false);
        return;
      }

      // Store customerCode for AuthContext (persist across F5)
      const loginData = {
        loginId: loginId.trim(),
        loginPass: loginPass.trim(),
        customerCode: customerDoc.id,
      };
      (window as any).__customerLogin = loginData;
      localStorage.setItem('customerLogin', JSON.stringify(loginData));

      // Signal AuthContext to process the guest login
      onAnonymousReady();
    } catch (err: any) {
      console.error('Customer login error:', err);
      delete (window as any).__customerLogin;
      localStorage.removeItem('customerLogin');
      if (err?.code === 'auth/admin-restricted-operation') {
        setLoginError(t('Anonymous Auth chưa được bật. Vui lòng bật trong Firebase Console > Authentication > Sign-in method > Anonymous.'));
      } else {
        setLoginError(t('Đăng nhập thất bại. Vui lòng thử lại.'));
      }
      setLoginLoading(false);
    }
  };

  const error = loginError || customerLoginError;

  return (
    <div className="min-h-screen bg-slate-100/50 flex flex-col items-center justify-center p-6 font-sans" id="login-screen">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-lg shadow-sm p-8 space-y-6 relative" id="login-box">
        {/* Language toggle */}
        <div className="absolute top-3 right-3">
          <button
            onClick={() => setLang(lang === 'en' ? 'vi' : 'en')}
            className="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-[10px] font-bold text-slate-500 transition-colors cursor-pointer"
          >
            <Globe size={12} />
            {lang === 'en' ? '🇬🇧 EN' : '🇻🇳 VI'}
          </button>
        </div>

        {/* Header */}
        <div className="flex flex-col items-center space-y-3" id="login-header">
          <div className="p-1.5 flex items-center justify-center">
            <img
              src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1784541481/logo-easycabinet-transparent_hahs7u.png"
              alt="DRACO-X2 Logo"
              className="object-contain"
              referrerPolicy="no-referrer"
            />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-black text-slate-800 uppercase tracking-tight">{t('Hệ Thống DRACO-X2')}</h1>
            <p className="text-xs text-slate-400 font-bold uppercase tracking-wider mt-1">{t('Hệ Thống Quản Lý & QC Hàng Chờ')}</p>
          </div>
        </div>

        <div className="h-px bg-slate-100"></div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
            <AlertCircle size={14} className="text-red-500 shrink-0" />
            <p className="text-xs text-red-600 font-medium">{error}</p>
          </div>
        )}

        {/* ID/PASS Login */}
        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{t('ID Đăng Nhập')}</label>
            <div className="relative mt-1">
              <UserRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
              <input
                type="text"
                value={loginId}
                onChange={e => setLoginId(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCustomerLogin(); }}
                className="w-full pl-9 pr-3 py-3 border border-slate-200 rounded-lg text-sm font-medium focus:border-indigo-500 outline-none"
                placeholder={t('Nhập ID')}
                autoFocus
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{t('Mật Khẩu')}</label>
            <div className="relative mt-1">
              <KeyRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
              <input
                type="password"
                value={loginPass}
                onChange={e => setLoginPass(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCustomerLogin(); }}
                className="w-full pl-9 pr-3 py-3 border border-slate-200 rounded-lg text-sm font-medium focus:border-amber-500 outline-none"
                placeholder={t('Nhập mật khẩu')}
              />
            </div>
          </div>
        </div>

        <button
          onClick={handleCustomerLogin}
          type="button"
          disabled={!loginId.trim() || !loginPass.trim() || loginLoading}
          className="w-full bg-indigo-600 hover:bg-slate-900 text-white font-black py-3.5 px-4 rounded-lg flex items-center justify-center space-x-3 transition-colors active:scale-[0.98] uppercase text-[11px] tracking-widest disabled:opacity-50 cursor-pointer"
        >
          {loginLoading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <LogIn size={16} />
          )}
          <span>{loginLoading ? t('Đang đăng nhập...') : t('Đăng nhập')}</span>
        </button>

        {/* Divider */}
        <div className="relative py-1 flex items-center justify-center">
          <div className="flex-grow border-t border-slate-100"></div>
          <span className="px-3 text-[9px] text-slate-400 font-black uppercase tracking-widest">OR</span>
          <div className="flex-grow border-t border-slate-100"></div>
        </div>

        {/* Google Login */}
        <button
          onClick={login}
          type="button"
          className="w-full bg-white hover:bg-slate-50 text-slate-700 font-black py-3.5 px-4 rounded-lg flex items-center justify-center space-x-3 transition-colors active:scale-[0.98] uppercase text-[11px] tracking-widest cursor-pointer border border-slate-200"
          id="google-login-btn"
        >
          <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          <span>{t('Đăng nhập với Google')}</span>
        </button>

        {/* Footer */}
        <div className="relative py-1 flex items-center justify-center">
          <div className="flex-grow border-t border-slate-100"></div>
          <span className="px-3 text-[9px] text-slate-400 font-black uppercase tracking-widest">{t('Thông tin hệ thống')}</span>
          <div className="flex-grow border-t border-slate-100"></div>
        </div>

        <p className="text-[11px] text-slate-400 text-center leading-relaxed italic">
          {t('Hệ thống tự động lưu trữ nhật ký hoạt động sản xuất, kiểm định chất lượng (QC) và phân hệ bàn giao lưu trữ trực tiếp trên cơ sở dữ liệu đám mây.')}
        </p>
      </div>
    </div>
  );
}
