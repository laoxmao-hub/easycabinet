/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Users, Shield, User, Loader2, X, Search, Trash2, Check } from 'lucide-react';
import { doc, updateDoc, addDoc, serverTimestamp, collection, deleteDoc } from 'firebase/firestore';
import { useAuth } from '../lib/AuthContext';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { UserProfile } from '../types';

interface UserManagementScreenProps {
 allUsers: UserProfile[];
}

const ALL_ROLES = [
 { value: 'admin', label: 'Quản trị viên', color: 'bg-rose-100 text-rose-600 border-rose-100' },
 { value: 'mod_x1', label: 'Điều phối X1', color: 'bg-indigo-100 text-indigo-600 border-indigo-100' },
 { value: 'mod_x2', label: 'Điều phối X2', color: 'bg-indigo-100 text-indigo-600 border-indigo-100' },
 { value: 'mod_qc', label: 'Điều phối QC', color: 'bg-violet-100 text-violet-600 border-violet-100' },
 { value: 'mod', label: 'Điều phối', color: 'bg-indigo-100 text-indigo-600 border-indigo-100' },
 { value: 'qc', label: 'Kiểm hàng', color: 'bg-cyan-100 text-cyan-600 border-cyan-100' },
 { value: 'member', label: 'Nhân viên', color: 'bg-emerald-100 text-emerald-600 border-emerald-100' },
 { value: 'viewer', label: 'Người xem', color: 'bg-slate-100 text-slate-500 border-slate-200' },
 { value: 'pending', label: 'Đợi duyệt', color: 'bg-orange-100 text-orange-600 border-orange-100' },
 { value: 'manager', label: 'Quản lý', color: 'bg-amber-100 text-amber-600 border-amber-100' },
];

function getUserRoles(u: UserProfile): string[] {
 if (Array.isArray(u.roles) && u.roles.length > 0) return u.roles;
 if (u.role) return [u.role];
 return [];
}

function getRoleStyle(roleValue: string) {
 return ALL_ROLES.find(r => r.value === roleValue) || { value: roleValue, label: roleValue.toUpperCase(), color: 'bg-slate-100 text-slate-500 border-slate-200' };
}

function getPrimaryRoleStyle(u: UserProfile) {
 const roles = getUserRoles(u);
 if (roles.includes('admin')) return getRoleStyle('admin');
 if (roles.includes('mod_x1')) return getRoleStyle('mod_x1');
 if (roles.includes('mod_x2')) return getRoleStyle('mod_x2');
 if (roles.includes('mod_qc')) return getRoleStyle('mod_qc');
 if (roles.includes('mod')) return getRoleStyle('mod');
 if (roles.includes('member')) return getRoleStyle('member');
 if (roles.includes('viewer')) return getRoleStyle('viewer');
 if (roles.length === 0) return getRoleStyle('pending');
 return getRoleStyle(roles[0]);
}

export function UserManagementScreen({ allUsers }: UserManagementScreenProps) {
 const { user } = useAuth();
 const [searchTerm, setSearchTerm] = useState('');
 const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);

 const filteredUsers = allUsers.filter(u => 
 (u.ten_that || u.displayName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
 (u.email || '').toLowerCase().includes(searchTerm.toLowerCase())
 );

 return (
 <div className="space-y-6 pb-24 lg:pb-8">
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
 <div>
 <h1 className="text-3xl font-black text-slate-900 uppercase tracking-tight">Quản Lý Nhân Sự</h1>
 <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mt-1">Phân quyền và quản lý tài khoản người dùng</p>
 </div>
 <div className="bg-white px-5 py-3 rounded-lg border border-slate-200 shadow-none">
 <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest block mb-1">Tổng nhân sự</span>
 <span className="text-2xl font-black text-indigo-600 leading-none">{allUsers.length}</span>
 </div>
 </div>

 <div className="bg-white rounded-lg border border-slate-200 shadow-none overflow-hidden">
 <div className="px-6 py-4 border-b border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
 <h3 className="text-[11px] font-black uppercase text-slate-800 tracking-widest flex items-center">
 <span className="w-2 h-2 bg-indigo-500 mr-2.5"></span>
 Danh sách tài khoản
 </h3>
 <div className="relative max-w-sm w-full">
 <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
 <input 
 type="text"
 placeholder="Tìm tên, email..."
 className="w-full pl-11 pr-4 py-2.5 bg-slate-100 border border-slate-200 rounded-lg text-sm font-black outline-none focus:border-indigo-600 transition-all uppercase placeholder:italic placeholder:font-normal placeholder:lowercase shadow-none"
 value={searchTerm}
 onChange={e => setSearchTerm(e.target.value)}
 />
 </div>
 </div>
 <div className="p-0 overflow-x-auto scrollbar-hide">
 <table className="w-full text-left border-collapse min-w-[650px]">
 <thead>
 <tr className="bg-slate-100 text-slate-400 text-[10px] font-black uppercase tracking-[0.15em] border-b border-slate-100">
 <th className="px-6 py-4 text-center w-16">STT</th>
 <th className="px-6 py-4">Nhân sự</th>
 <th className="px-6 py-4">Phân quyền / Vai trò</th>
 <th className="px-6 py-4 text-right w-24">Tác vụ</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100">
 {filteredUsers.sort((a, b) => {
 const aRoles = getUserRoles(a);
 const bRoles = getUserRoles(b);
 if (aRoles.includes('pending') && !bRoles.includes('pending')) return -1;
 if (!aRoles.includes('pending') && bRoles.includes('pending')) return 1;
 return 0;
 }).map((u, idx) => {
 const userRoles = getUserRoles(u);
 const primaryStyle = getPrimaryRoleStyle(u);
 const isPending = userRoles.length === 0 || userRoles.includes('pending');
 return (
 <tr key={u.uid} className={`hover:bg-slate-100/50 transition-all group ${isPending ? 'bg-red-100/30' : ''}`}>
 <td className="px-6 py-4 text-center text-[11px] font-black text-slate-300">{idx + 1}</td>
 <td className="px-6 py-4">
 <div className="flex items-center space-x-4">
 <div className="w-11 h-11 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center overflow-hidden shrink-0 shadow-sm">
 {u.photoURL ? (
 <img src={u.photoURL} alt={u.displayName} className="w-full h-full object-cover" />
 ) : (
 <div className="w-full h-full bg-slate-800 flex items-center justify-center text-white text-[11px] font-black uppercase">
 {u.displayName?.substring(0, 2) || u.email?.substring(0, 2) || 'NV'}
 </div>
 )}
 </div>
 <div className="flex flex-col">
 <span className="text-sm font-black text-slate-800 uppercase tracking-tight">{u.ten_that || u.displayName}</span>
 <span className="text-[10px] text-slate-400 font-bold lowercase">{u.email}</span>
 {isPending && (
 <span className="text-[8px] font-black text-rose-500 uppercase tracking-widest mt-0.5 animate-pulse">Đang chờ cấp quyền</span>
 )}
 </div>
 </div>
 </td>
 <td className="px-6 py-4">
 <div className="flex flex-wrap items-center gap-1.5">
 {userRoles.length > 0 ? userRoles.map(r => {
 const style = getRoleStyle(r);
 return (
 <span key={r} className={`text-[9px] font-black px-2.5 py-1 rounded-lg uppercase tracking-[0.12em] border shadow-sm ${style.color}`}>
 {style.label}
 </span>
 );
 }) : (
 <span className="text-[9px] font-black px-3 py-1.5 rounded-lg uppercase tracking-[0.12em] border shadow-sm bg-orange-100 text-orange-600 border-orange-100">
 ĐỢI DUYỆT
 </span>
 )}
 </div>
 </td>
 <td className="px-6 py-4 text-right">
 <button 
 onClick={() => setSelectedUser(u)}
 className="p-2.5 bg-white text-slate-400 hover:text-indigo-600 hover:border-indigo-200 rounded-lg border border-slate-100 transition-all shadow-sm flex items-center justify-center ml-auto"
 >
 <Shield size={16} />
 </button>
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 {filteredUsers.length === 0 && (
 <div className="text-center py-20 bg-white">
 <Users size={64} className="mx-auto text-slate-100 mb-4" />
 <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest italic">Không tìm thấy nhân sự phù hợp</p>
 </div>
 )}
 </div>
 </div>

 {selectedUser && (
 <UserEditModal 
 profile={selectedUser} 
 onClose={() => setSelectedUser(null)} 
 />
 )}
 </div>
 );
}

function UserEditModal({ profile, onClose }: { profile: UserProfile, onClose: () => void }) {
 const { user, userProfile } = useAuth();
 const userRoles = getUserRoles(profile);
 const [selectedRoles, setSelectedRoles] = useState<string[]>(userRoles);
 const [tenThat, setTenThat] = useState(profile.ten_that || '');
 const [chucDanh, setChucDanh] = useState(profile.chuc_danh || '');
 const [loading, setLoading] = useState(false);
 const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

 const toggleRole = (roleValue: string) => {
 setSelectedRoles(prev => 
 prev.includes(roleValue) 
 ? prev.filter(r => r !== roleValue)
 : [...prev, roleValue]
 );
 };

 const handleDelete = async () => {
 if (!user) return;
 if (user.uid === profile.uid) return alert('Không thể tự xóa tài khoản của chính mình!');
 
 setLoading(true);
 try {
 await deleteDoc(doc(db, 'users', profile.uid));
 
 const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');

 await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: displayLabel,
 userEmail: user.email,
 action: 'Xóa nhân sự',
 details: `Đã xóa tài khoản: ${profile.ten_that || profile.displayName} (${profile.email})`,
 timestamp: serverTimestamp()
 });

 onClose();
 } catch (e: any) {
 handleFirestoreError(e, OperationType.DELETE, 'users');
 } finally {
 setLoading(false);
 }
 };

 const handleUpdate = async () => {
 if (!user) return;
 if (user.uid === profile.uid && JSON.stringify(selectedRoles) !== JSON.stringify(userRoles)) {
 return alert('Không thể tự sửa quyền của chính mình');
 }
 setLoading(true);
 try {
 const primaryRole = selectedRoles.length > 0 ? selectedRoles[0] : 'pending';
 await updateDoc(doc(db, 'users', profile.uid), { 
 role: primaryRole,
 roles: selectedRoles,
 ten_that: tenThat,
 chuc_danh: chucDanh
 });
 
 const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');

 await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: displayLabel,
 userEmail: user.email,
 action: 'Cập nhật phân quyền',
 details: `Cập nhật quyền của ${profile.displayName}: [${selectedRoles.join(', ')}]`,
 timestamp: serverTimestamp()
 });

 onClose();
 } catch (e: any) {
 handleFirestoreError(e, OperationType.UPDATE, 'users');
 } finally {
 setLoading(false);
 }
 };

 const hasChanges = JSON.stringify(selectedRoles) !== JSON.stringify(userRoles) || tenThat !== (profile.ten_that || '') || chucDanh !== (profile.chuc_danh || '');

 return (
 <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
 <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-slate-200">
 <div className="p-6 border-b border-slate-100 flex items-center space-x-5 bg-white">
 <div className="relative group">
 {profile.photoURL ? (
 <img src={profile.photoURL} alt={profile.displayName} className="w-16 h-16 rounded-lg border border-slate-200 object-cover shadow-sm group-hover:scale-105 transition-transform" />
 ) : (
 <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center justify-center text-slate-400 border border-slate-200">
 <User size={32} />
 </div>
 )}
 <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-emerald-500 border-2 border-white rounded-full shadow-sm"></div>
 </div>
 <div className="min-w-0 flex-1">
 <h3 className="text-lg font-black text-slate-900 uppercase tracking-tight truncate leading-tight">{profile.ten_that || profile.displayName}</h3>
 <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest truncate mt-1">{profile.email}</p>
 </div>
 <button onClick={onClose} className="p-2 text-slate-400 hover:text-rose-500 transition-colors">
 <X size={20} />
 </button>
 </div>

 <div className="p-8 space-y-6 max-h-[65vh] overflow-y-auto custom-scrollbar">
 <div className="space-y-6">
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none flex items-center gap-2">
 <User size={12} /> Họ và tên (Thực tế)
 </label>
 <input 
 type="text"
 value={tenThat}
 onChange={e => setTenThat(e.target.value)}
 placeholder="NHẬP TÊN ĐẦY ĐỦ..."
 className="w-full px-4 py-3 bg-slate-100 border border-slate-200 rounded-lg text-sm font-black text-slate-800 outline-none focus:border-indigo-600 transition-all uppercase shadow-none"
 />
 </div>
 
 <div className="space-y-3">
 <label className="text-[10px] font-black text-indigo-500 uppercase tracking-widest leading-none flex items-center gap-2">
 <Shield size={12} /> Phân quyền Tài khoản (chọn nhiều)
 </label>
 <div className="grid grid-cols-2 gap-2">
 {ALL_ROLES.filter(r => r.value !== 'pending').map(r => {
 const isSelected = selectedRoles.includes(r.value);
 return (
 <button
 key={r.value}
 type="button"
 onClick={() => toggleRole(r.value)}
 className={`flex items-center justify-between px-3 py-2.5 rounded-lg border text-[11px] font-black uppercase tracking-widest transition-all ${
 isSelected 
 ? 'bg-indigo-100 border-indigo-300 text-indigo-700' 
 : 'bg-white border-slate-200 text-slate-400 hover:border-slate-300'
 }`}
 >
 <span>{r.label}</span>
 {isSelected && <Check size={14} className="text-indigo-500" />}
 </button>
 );
 })}
 </div>
 {selectedRoles.length === 0 && (
 <p className="text-[10px] text-orange-500 font-bold italic">Chưa chọn vai trò nào — tài khoản sẽ ở trạng thái "Đợi duyệt"</p>
 )}
 <p className="text-[9px] text-slate-400 font-bold uppercase tracking-tight italic opacity-75 leading-relaxed">Lưu ý: Người dùng sẽ có quyền của TẤT CẢ các vai trò được chọn.</p>
 </div>

 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none flex items-center gap-2">
 <Shield size={12} /> Bộ phận / Chức danh
 </label>
 <input 
 type="text"
 value={chucDanh}
 onChange={e => setChucDanh(e.target.value)}
 placeholder="NHÂN VIÊN..."
 className="w-full px-4 py-3 bg-slate-100 border border-slate-200 rounded-lg text-sm font-black text-slate-800 outline-none focus:border-indigo-600 transition-all uppercase shadow-none"
 />
 </div>
 </div>
 </div>

 <div className="flex bg-slate-100 border-t border-slate-100 p-5 space-x-3">
 {showDeleteConfirm ? (
 <div className="flex-1 flex space-x-3 animate-in slide-in-from-bottom-2 duration-300">
 <button 
 onClick={() => setShowDeleteConfirm(false)}
 className="flex-1 py-3 bg-white text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest border border-slate-200 hover:bg-slate-100 transition-all"
 >
 HUỶ BỎ
 </button>
 <button 
 onClick={handleDelete}
 className="flex-1 py-3 bg-rose-600 text-white rounded-lg text-[11px] font-black uppercase tracking-widest shadow-xl shadow-rose-100 hover:bg-rose-700 transition-all flex items-center justify-center space-x-2 active:scale-95"
 >
 {loading ? <Loader2 size={16} className="animate-spin" /> : <span>XOÁ VĨNH VIỄN</span>}
 </button>
 </div>
 ) : (
 <>
 <button 
 onClick={() => setShowDeleteConfirm(true)}
 className="p-3 text-slate-300 hover:text-rose-500 bg-white hover:bg-rose-100 rounded-lg border border-slate-200 transition-all group"
 title="Xóa người dùng"
 >
 <Trash2 size={20} className="group-hover:scale-110 transition-transform" />
 </button>
 <button onClick={onClose} className="px-6 py-3 bg-white text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest border border-slate-200 hover:bg-slate-100 transition-all active:scale-95">HUỶ</button>
 <button 
 disabled={loading || !hasChanges}
 onClick={handleUpdate}
 className="flex-1 py-3 bg-indigo-600 text-white rounded-lg text-[11px] font-black uppercase tracking-widest shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all disabled:opacity-100 flex items-center justify-center space-x-2 active:scale-95"
 >
 {loading ? <Loader2 size={16} className="animate-spin" /> : <span>LƯU CẬP NHẬT</span>}
 </button>
 </>
 )}
 </div>
 </motion.div>
 </div>
 );
}
