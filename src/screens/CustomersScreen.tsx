import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Users, Plus, X, Trash2, Copy, Check, KeyRound, UserRound,
  Loader2, Building2, Phone, Mail, MapPin, ChevronDown, ChevronRight, FolderOpen,
  Eye, EyeOff, Briefcase, MapPinned
} from 'lucide-react';
import { db, addCustomer, updateCustomer, deleteCustomer, onCustomersSnapshot } from '../lib/firebase';
import { ProjectEntry, Customer, CustomerProject } from '../types';
import { useAuth } from '../lib/AuthContext';
import { formatProjectCode, formatProjectName } from '../lib/formatters';

interface CustomersScreenProps {
  projectEntries: ProjectEntry[];
}

export function CustomersScreen({ projectEntries }: CustomersScreenProps) {
  const { user, hasRole } = useAuth();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [formType, setFormType] = useState<'customer' | 'worksite'>('customer');
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formLoginId, setFormLoginId] = useState('');
  const [formLoginPass, setFormLoginPass] = useState('');
  const [formProjects, setFormProjects] = useState<CustomerProject[]>([]);
  const [formNote, setFormNote] = useState('');
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [newProjectCode, setNewProjectCode] = useState('');
  const [newSubCode, setNewSubCode] = useState('');
  const [copiedLoginId, setCopiedLoginId] = useState<string | null>(null);
  const [showPassMap, setShowPassMap] = useState<Record<string, boolean>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<Customer | null>(null);
  const [saving, setSaving] = useState(false);

  const CUSTOMERS_CACHE_KEY = 'draco_customers_cache';
  const CUSTOMERS_TS_KEY = 'draco_customers_ts';
  const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

  useEffect(() => {
    try {
      const ts = Number(localStorage.getItem(CUSTOMERS_TS_KEY) || 0);
      if (Date.now() - ts <= CACHE_MAX_AGE_MS) {
        const raw = localStorage.getItem(CUSTOMERS_CACHE_KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          if (Array.isArray(cached) && cached.length > 0) {
            setCustomers(cached as Customer[]);
            setLoading(false);
          }
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    const unsub = onCustomersSnapshot((data) => {
      setCustomers(data as Customer[]);
      setLoading(false);
      try {
        localStorage.setItem(CUSTOMERS_CACHE_KEY, JSON.stringify(data));
        localStorage.setItem(CUSTOMERS_TS_KEY, String(Date.now()));
      } catch {}
    });
    return () => unsub();
  }, []);

  const customerList = useMemo(() => customers.filter(c => c.type !== 'worksite'), [customers]);
  const workSiteList = useMemo(() => customers.filter(c => c.type === 'worksite'), [customers]);

  const openCreate = (type: 'customer' | 'worksite') => {
    setEditingCustomer(null);
    setFormType(type);
    setFormName('');
    setFormPhone('');
    setFormEmail('');
    setFormAddress('');
    setFormLoginId('');
    setFormLoginPass('');
    setFormProjects([]);
    setFormNote('');
    setExpandedProject(null);
    setShowModal(true);
  };

  const openEdit = (customer: Customer) => {
    setEditingCustomer(customer);
    setFormType(customer.type === 'worksite' ? 'worksite' : 'customer');
    setFormName(customer.name);
    setFormPhone(customer.phone || '');
    setFormEmail(customer.email || '');
    setFormAddress(customer.address || '');
    setFormLoginId(customer.loginId || '');
    setFormLoginPass(customer.loginPass || '');
    const projects = (customer as any).projects || (customer as any).projectCodes?.map((c: string) => ({ code: c, subCodes: [] })) || [];
    setFormProjects(projects);
    setFormNote(customer.note || '');
    setExpandedProject(null);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !user) return;
    setSaving(true);
    try {
      const data = {
        name: formName.trim(),
        phone: formPhone.trim(),
        email: formEmail.trim(),
        address: formAddress.trim(),
        loginId: formLoginId.trim(),
        loginPass: formLoginPass.trim(),
        projects: formProjects,
        type: formType,
        note: formNote.trim(),
      };
      if (editingCustomer) {
        await updateCustomer(editingCustomer.id, data);
      } else {
        await addCustomer({ ...data, createdBy: user.uid });
      }
      setShowModal(false);
    } catch (err) {
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCustomer(id);
      setDeleteConfirm(null);
    } catch (err) {
      console.error('Delete error:', err);
    }
  };

  const copyLoginInfo = (customerId: string, loginId: string, loginPass: string) => {
    const text = `ID: ${loginId}\nPASS: ${loginPass}`;
    navigator.clipboard.writeText(text);
    setCopiedLoginId(customerId);
    setTimeout(() => setCopiedLoginId(null), 2000);
  };

  const allProjectCodes = Array.from(new Set(projectEntries.map(e => e.projectCode))).map(code => {
    const entry = projectEntries.find(e => e.projectCode === code);
    return { code, name: formatProjectName(entry?.projectName) || 'Không tên' };
  });

  const getSubCodeSuggestions = (projectCode: string, input: string) => {
    if (!input.trim()) return [];
    const lower = input.toLowerCase();
    const existingSubs = formProjects.find(p => p.code === projectCode)?.subCodes || [];
    return allProjectCodes.filter(p =>
      !existingSubs.includes(p.code) &&
      (p.code.toLowerCase().includes(lower) || p.name.toLowerCase().includes(lower))
    ).slice(0, 10);
  };

  const addProject = () => {
    const code = newProjectCode.trim().toUpperCase();
    if (!code) return;
    if (formProjects.some(p => p.code === code)) return;
    setFormProjects([...formProjects, { code, subCodes: [] }]);
    setNewProjectCode('');
    setExpandedProject(code);
  };

  const removeProject = (code: string) => {
    setFormProjects(formProjects.filter(p => p.code !== code));
    if (expandedProject === code) setExpandedProject(null);
  };

  const addSubCode = (projectCode: string, subCode?: string) => {
    const sub = (subCode || newSubCode).trim().toUpperCase();
    if (!sub) return;
    setFormProjects(formProjects.map(p => {
      if (p.code !== projectCode) return p;
      if (p.subCodes.includes(sub)) return p;
      return { ...p, subCodes: [...p.subCodes, sub] };
    }));
    setNewSubCode('');
  };

  const removeSubCode = (projectCode: string, subCode: string) => {
    setFormProjects(formProjects.map(p => {
      if (p.code !== projectCode) return p;
      return { ...p, subCodes: p.subCodes.filter(s => s !== subCode) };
    }));
  };

  const renderCustomerCard = (customer: Customer) => {
    const projects = (customer as any).projects || (customer as any).projectCodes?.map((c: string) => ({ code: c, subCodes: [] })) || [];
    const loginId = (customer as any).loginId || '';
    const loginPass = (customer as any).loginPass || '';
    const hasLogin = !!(loginId || loginPass);
    const passVisible = !!showPassMap[customer.id];
    const isWorkSite = customer.type === 'worksite';

    return (
      <div key={customer.id} className="bg-white rounded-lg border border-slate-200 p-4 hover:border-slate-300 transition-colors">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-8 h-8 rounded-lg ${isWorkSite ? 'bg-emerald-100' : 'bg-cyan-100'} flex items-center justify-center shrink-0`}>
              {isWorkSite ? <MapPinned size={14} className="text-emerald-600" /> : <Users size={14} className="text-cyan-600" />}
            </div>
            <h3 className="text-sm font-black text-slate-900 uppercase truncate">{customer.name}</h3>
            {hasLogin && (
              <div className="hidden sm:flex items-center gap-1.5 ml-1 text-[10px]">
                {loginId && (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-indigo-50 border border-indigo-100 rounded text-indigo-700 font-bold">
                    <UserRound size={9} />
                    <span>{loginId}</span>
                  </span>
                )}
                {loginPass && (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-50 border border-amber-100 rounded text-amber-700 font-bold">
                    <KeyRound size={9} />
                    <span className="tracking-wider">{passVisible ? loginPass : '••••••'}</span>
                    <button
                      onClick={() => setShowPassMap(prev => ({ ...prev, [customer.id]: !prev[customer.id] }))}
                      className="p-0 hover:text-amber-900 cursor-pointer"
                      title={passVisible ? 'Ẩn' : 'Hiện'}
                    >
                      {passVisible ? <EyeOff size={8} /> : <Eye size={8} />}
                    </button>
                  </span>
                )}
                <button
                  onClick={() => copyLoginInfo(customer.id, loginId, loginPass)}
                  className="p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-indigo-600 transition-colors cursor-pointer"
                  title="Copy ID & PASS"
                >
                  {copiedLoginId === customer.id ? <Check size={9} className="text-emerald-500" /> : <Copy size={9} />}
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => openEdit(customer)}
              className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-amber-600 transition-colors cursor-pointer"
              title="Sửa"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            </button>
            {hasRole('admin') && (
              <button
                onClick={() => setDeleteConfirm(customer)}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-red-500 transition-colors cursor-pointer"
                title="Xóa"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>

        {hasLogin && (
          <div className="flex sm:hidden items-center gap-2 ml-10 mb-1.5 text-[10px]">
            {loginId && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-indigo-50 border border-indigo-100 rounded text-indigo-700 font-bold">
                <UserRound size={9} />
                <span>{loginId}</span>
              </span>
            )}
            {loginPass && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-50 border border-amber-100 rounded text-amber-700 font-bold">
                <KeyRound size={9} />
                <span className="tracking-wider">{passVisible ? loginPass : '••••••'}</span>
                <button
                  onClick={() => setShowPassMap(prev => ({ ...prev, [customer.id]: !prev[customer.id] }))}
                  className="p-0 hover:text-amber-900 cursor-pointer"
                >
                  {passVisible ? <EyeOff size={8} /> : <Eye size={8} />}
                </button>
              </span>
            )}
            <button
              onClick={() => copyLoginInfo(customer.id, loginId, loginPass)}
              className="p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-indigo-600 transition-colors cursor-pointer"
              title="Copy ID & PASS"
            >
              {copiedLoginId === customer.id ? <Check size={9} className="text-emerald-500" /> : <Copy size={9} />}
            </button>
          </div>
        )}

        {(customer.phone || customer.email || customer.address) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 ml-10 mb-2">
            {customer.phone && (
              <span className="flex items-center gap-1"><Phone size={10} className="text-slate-400" /> {customer.phone}</span>
            )}
            {customer.email && (
              <span className="flex items-center gap-1"><Mail size={10} className="text-slate-400" /> {customer.email}</span>
            )}
            {customer.address && (
              <span className="flex items-center gap-1"><MapPin size={10} className="text-slate-400" /> {customer.address}</span>
            )}
          </div>
        )}

        {projects.length > 0 ? (
          <div className="ml-10 space-y-1.5">
            {projects.map((proj: CustomerProject) => (
              <div key={proj.code} className="flex items-start gap-2">
                <span className={`text-[10px] font-black px-2 py-0.5 ${isWorkSite ? 'bg-emerald-100 text-emerald-700' : 'bg-cyan-100 text-cyan-700'} rounded uppercase tracking-widest shrink-0 mt-0.5`}>
                  {proj.code}
                </span>
                {proj.subCodes?.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {proj.subCodes.map(sub => (
                      <span key={sub} className="text-[9px] font-bold px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded border border-slate-200 uppercase">
                        {sub}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-[9px] text-slate-300 italic mt-0.5">Không có mã con</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="ml-10">
            <span className="text-[9px] text-slate-300 italic">Chưa có dự án</span>
          </div>
        )}

        {customer.note && (
          <div className="ml-10 mt-1.5">
            <span className="text-[10px] text-slate-400 italic">{customer.note}</span>
          </div>
        )}
      </div>
    );
  };

  const renderSection = (
    title: string,
    icon: React.ReactNode,
    list: Customer[],
    accent: string,
    emptyText: string,
    type: 'customer' | 'worksite'
  ) => (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-black text-slate-900 uppercase tracking-tight">{title}</h2>
          <span className="text-xs font-black text-slate-400">({list.length})</span>
        </div>
        <button
          onClick={() => openCreate(type)}
          className={`px-3 py-1.5 ${accent === 'emerald' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-cyan-600 hover:bg-cyan-700'} text-white rounded-lg text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1`}
        >
          <Plus size={12} />
          {type === 'worksite' ? 'Thêm công trường' : 'Thêm khách'}
        </button>
      </div>
      {list.length === 0 ? (
        <div className="bg-white rounded-lg border border-slate-200 p-8 text-center">
          {type === 'worksite' ? <Briefcase size={32} className="text-slate-200 mx-auto mb-2" /> : <Users size={32} className="text-slate-200 mx-auto mb-2" />}
          <p className="text-xs font-bold text-slate-400">{emptyText}</p>
        </div>
      ) : (
        <div className="grid gap-3">{list.map(renderCustomerCard)}</div>
      )}
    </div>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-indigo-600" />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Building2 size={20} className="text-cyan-600" />
        <h1 className="text-lg font-black text-slate-900 uppercase tracking-tight">Tài Khoản</h1>
      </div>

      {/* Section: Tài khoản khách */}
      {renderSection(
        'Tài khoản khách',
        <Users size={16} className="text-cyan-600" />,
        customerList,
        'cyan',
        'Chưa có tài khoản khách nào',
        'customer'
      )}

      <div className="border-t border-slate-200" />

      {/* Section: Tài khoản công trường */}
      {renderSection(
        'Tài khoản công trường',
        <Briefcase size={16} className="text-emerald-600" />,
        workSiteList,
        'emerald',
        'Chưa có công trường nào',
        'worksite'
      )}

      {/* ── Create/Edit Modal ──────────────────────────────────────── */}
      <AnimatePresence>
        {showModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white w-full max-w-4xl rounded-lg shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight">
                  {editingCustomer
                    ? (formType === 'worksite' ? 'Sửa công trường' : 'Sửa khách hàng')
                    : (formType === 'worksite' ? 'Thêm công trường' : 'Thêm khách hàng')}
                </h3>
                <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 cursor-pointer">
                  <X size={16} />
                </button>
              </div>

              <div className="p-4 max-h-[70vh] overflow-y-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Left: Info */}
                  <div className="space-y-3">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                        {formType === 'worksite' ? 'Tên công trường *' : 'Tên khách hàng *'}
                      </label>
                      <input
                        type="text"
                        value={formName}
                        onChange={e => setFormName(e.target.value)}
                        className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:border-cyan-500 outline-none"
                        placeholder={formType === 'worksite' ? 'Tên công trường' : 'Tên công ty / cá nhân'}
                      />
                    </div>
                    {formType === 'worksite' && (
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Ghi chú</label>
                        <textarea
                          value={formNote}
                          onChange={e => setFormNote(e.target.value)}
                          className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:border-emerald-500 outline-none resize-none"
                          rows={2}
                          placeholder="Ghi chú về công trường..."
                        />
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Số điện thoại</label>
                        <input
                          type="tel"
                          value={formPhone}
                          onChange={e => setFormPhone(e.target.value)}
                          className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:border-cyan-500 outline-none"
                          placeholder="0901 234 567"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Email</label>
                        <input
                          type="email"
                          value={formEmail}
                          onChange={e => setFormEmail(e.target.value)}
                          className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:border-cyan-500 outline-none"
                          placeholder="email@example.com"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Địa chỉ</label>
                      <input
                        type="text"
                        value={formAddress}
                        onChange={e => setFormAddress(e.target.value)}
                        className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:border-cyan-500 outline-none"
                        placeholder="Địa chỉ"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">ID đăng nhập</label>
                        <input
                          type="text"
                          value={formLoginId}
                          onChange={e => setFormLoginId(e.target.value)}
                          className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:border-indigo-500 outline-none"
                          placeholder="VD: tencongty"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Mật khẩu</label>
                        <input
                          type="text"
                          value={formLoginPass}
                          onChange={e => setFormLoginPass(e.target.value)}
                          className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:border-amber-500 outline-none"
                          placeholder="Mật khẩu"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Right: Projects */}
                  <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                      Dự án ({formProjects.length})
                    </label>

                  <div className="mt-2 space-y-2">
                    {formProjects.map(proj => {
                      const isExpanded = expandedProject === proj.code;
                      return (
                        <div key={proj.code} className="border border-slate-200 rounded-lg relative">
                          <div
                            className={`flex items-center gap-2 px-3 py-2 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors ${isExpanded ? 'rounded-t-lg' : 'rounded-lg'}`}
                            onClick={() => setExpandedProject(isExpanded ? null : proj.code)}
                          >
                            {isExpanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
                            <FolderOpen size={14} className="text-cyan-600" />
                            <span className="text-xs font-black text-slate-700 uppercase flex-1">{proj.code}</span>
                            <span className="text-[10px] text-slate-400">{proj.subCodes.length} mã con</span>
                            <button
                              onClick={e => { e.stopPropagation(); removeProject(proj.code); }}
                              className="p-1 rounded hover:bg-red-100 text-slate-300 hover:text-red-500 cursor-pointer"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>

                          {isExpanded && (
                            <div className="px-3 py-2 border-t border-slate-200 bg-white rounded-b-lg">
                              <div className="flex flex-wrap gap-1 mb-2">
                                {proj.subCodes.map(sub => (
                                  <span key={sub} className="inline-flex items-center gap-1 text-[9px] font-black px-2 py-1 bg-cyan-100 text-cyan-700 rounded uppercase tracking-widest">
                                    {sub}
                                    <button onClick={() => removeSubCode(proj.code, sub)} className="hover:text-cyan-900 cursor-pointer"><X size={10} /></button>
                                  </span>
                                ))}
                                {proj.subCodes.length === 0 && (
                                  <span className="text-[10px] text-slate-300 italic">Chưa có mã con</span>
                                )}
                              </div>
                              <div className="relative">
                                <div className="flex gap-2">
                                  <input
                                    type="text"
                                    value={expandedProject === proj.code ? newSubCode : ''}
                                    onChange={e => { setExpandedProject(proj.code); setNewSubCode(e.target.value); }}
                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSubCode(proj.code); } }}
                                    className="flex-1 px-2 py-1.5 border border-slate-200 rounded text-[11px] font-medium focus:border-cyan-500 outline-none"
                                    placeholder="Nhập mã con (VD: BLDG1)..."
                                  />
                                  <button
                                    onClick={() => addSubCode(proj.code)}
                                    className="px-2 py-1.5 bg-cyan-100 hover:bg-cyan-200 text-cyan-700 rounded text-[10px] font-black cursor-pointer"
                                  >
                                    + Thêm
                                  </button>
                                </div>
                                {expandedProject === proj.code && newSubCode.trim() && (
                                  <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-40 overflow-y-auto divide-y divide-slate-100">
                                    {getSubCodeSuggestions(proj.code, newSubCode).length === 0 ? (
                                      <div className="px-3 py-2 text-[10px] text-slate-400 text-center">
                                        Nhấn Enter hoặc "+ Thêm" để thêm mã "{newSubCode.toUpperCase()}"
                                      </div>
                                    ) : (
                                      getSubCodeSuggestions(proj.code, newSubCode).map(p => (
                                        <button
                                          key={p.code}
                                          onClick={() => { addSubCode(proj.code, p.code); }}
                                          className="w-full px-3 py-2 text-left hover:bg-cyan-50 transition-colors flex items-center justify-between cursor-pointer"
                                        >
                                          <div className="flex items-center gap-2">
                                            <span className="text-[11px] font-black text-slate-700 uppercase">{p.code}</span>
                                            <span className="text-[10px] text-slate-400 truncate">{p.name}</span>
                                          </div>
                                          <span className="text-[10px] text-cyan-600 font-bold">+ Chọn</span>
                                        </button>
                                      ))
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex gap-2 mt-3">
                    <input
                      type="text"
                      value={newProjectCode}
                      onChange={e => setNewProjectCode(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addProject(); } }}
                      className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:border-cyan-500 outline-none"
                      placeholder="Nhập mã dự án mới (VD: PO02)..."
                    />
                    <button
                      onClick={addProject}
                      className="px-3 py-2 bg-cyan-100 hover:bg-cyan-200 text-cyan-700 rounded-lg text-xs font-black uppercase cursor-pointer shrink-0"
                    >
                      + Thêm dự án
                    </button>
                  </div>
                  </div>
                </div>
              </div>

              <div className="p-4 border-t border-slate-100 flex gap-3">
                <button
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs font-black uppercase tracking-widest transition-all"
                >
                  Hủy
                </button>
                <button
                  onClick={handleSave}
                  disabled={!formName.trim() || saving}
                  className={`flex-1 py-2.5 ${formType === 'worksite' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-cyan-600 hover:bg-cyan-700'} text-white rounded-lg text-xs font-black uppercase tracking-widest transition-all disabled:opacity-50 flex items-center justify-center gap-2`}
                >
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {editingCustomer ? 'Cập nhật' : 'Tạo mới'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Delete Confirm ──────────────────────────────────────────── */}
      <AnimatePresence>
        {deleteConfirm && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white w-full max-w-sm rounded-lg shadow-2xl border border-slate-200 p-6 text-center"
            >
              <Trash2 size={32} className="text-red-500 mx-auto mb-3" />
              <h3 className="text-sm font-black text-slate-900 mb-1">
                {deleteConfirm.type === 'worksite' ? 'Xóa công trường?' : 'Xóa tài khoản?'}
              </h3>
              <p className="text-xs text-slate-500 mb-4">{deleteConfirm.name}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs font-black uppercase tracking-widest transition-all"
                >
                  Hủy
                </button>
                <button
                  onClick={() => handleDelete(deleteConfirm.id)}
                  className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-black uppercase tracking-widest transition-all"
                >
                  Xóa
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}