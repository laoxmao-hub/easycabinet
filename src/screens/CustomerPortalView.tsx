import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'motion/react';import { Loader2, AlertCircle, Eye, Boxes, Package, Truck,
  LogOut, Building2, CheckCircle, XCircle, ChevronRight, Settings
} from 'lucide-react';
import { doc, getDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../lib/AuthContext';
import { useLanguage } from '../lib/LanguageContext';
import { GuestSettingsModal } from '../components/GuestSettingsModal';
import { ProjectEntry, Customer, getModuleInstances, getModuleQcAggregate } from '../types';
import { getEntryType } from '../lib/qcCriteria';
import { buildAndSortTree } from './ProjectManagementScreen';
import { formatProjectCode, formatProjectName } from '../lib/formatters';

type PortalTab = 'projects' | 'packing' | 'loading';

interface CustomerPortalViewProps {
  customerId: string;
}

export function CustomerPortalView({ customerId }: CustomerPortalViewProps) {
  const { user, login, logout, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [modules, setModules] = useState<ProjectEntry[]>([]);
  const [packingData, setPackingData] = useState<any[]>([]);
  const [loadingData, setLoadingData] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<PortalTab>('projects');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedModuleDetail, setSelectedModuleDetail] = useState<ProjectEntry | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const { lang } = useLanguage();

  // Load customer info
  useEffect(() => {
    if (authLoading) return;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const snap = await getDoc(doc(db, 'customers', customerId));
        if (!snap.exists()) {
          setError('Không tìm thấy khách hàng.');
          setLoading(false);
          return;
        }
        setCustomer({ id: snap.id, ...snap.data() } as Customer);
      } catch (err) {
        setError('Lỗi tải thông tin khách hàng.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [customerId, authLoading]);

  // Load modules for customer's projects
  useEffect(() => {
    if (!customer || !user) return;
    const loadModules = async () => {
      try {
        const allModules: ProjectEntry[] = [];
        for (const projectCode of customer.projectCodes) {
          const configsSnap = await getDocs(
            query(collection(db, 'projectConfigs'), where('projectCode', '==', projectCode))
          );
          for (const configDoc of configsSnap.docs) {
            const config = configDoc.data();
            const modulesSnap = await getDocs(collection(db, 'projectConfigs', configDoc.id, 'modules'));
            modulesSnap.docs.forEach(modDoc => {
              allModules.push({
                ...modDoc.data(),
                id: modDoc.id,
                configId: configDoc.id,
                projectName: config.projectName || '',
                projectCode: config.projectCode || '',
                glbUrl: config.glbUrl || '',
                drawingUrl: config.drawingUrl || '',
                assemblyDrawingUrl: config.assemblyDrawingUrl || '',
              } as ProjectEntry);
            });
          }
        }
        setModules(allModules);
      } catch (err) {
        console.error('Load modules error:', err);
      }
    };
    loadModules();
  }, [customer, user]);

  // Load packing data
  useEffect(() => {
    if (!customer || !user) return;
    const loadPacking = async () => {
      try {
        const snap = await getDocs(collection(db, 'packing'));
        const filtered = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter((p: any) => customer.projectCodes.includes(p.projectCode));
        setPackingData(filtered);
      } catch (err) {
        console.error('Load packing error:', err);
      }
    };
    loadPacking();
  }, [customer, user]);

  // Load loading data
  useEffect(() => {
    if (!customer || !user) return;
    const loadLoading = async () => {
      try {
        const snap = await getDocs(collection(db, 'loading'));
        const filtered = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter((l: any) => customer.projectCodes.includes(l.projectCode));
        setLoadingData(filtered);
      } catch (err) {
        console.error('Load loading error:', err);
      }
    };
    loadLoading();
  }, [customer, user]);

  // Filter modules by selected project
  const filteredModules = useMemo(() => {
    let list = modules;
    if (selectedProject) {
      list = list.filter(m => m.projectCode === selectedProject);
    }
    return buildAndSortTree(list);
  }, [modules, selectedProject]);

  const projectList = useMemo(() => {
    return Array.from(new Set(modules.map(m => m.projectCode))).map(code => {
      const entry = modules.find(m => m.projectCode === code);
      return { code, name: formatProjectName(entry?.projectName) || 'Không tên' };
    });
  }, [modules]);

  const handleRowClick = useCallback((entry: ProjectEntry) => {
    if (typeof window !== 'undefined' && window.innerWidth >= 1024) {
      setSelectedModuleDetail(prev => prev?.id === entry.id ? null : entry);
    } else {
      setSelectedModuleId(entry.id);
    }
  }, []);

  // Login prompt
  if (!authLoading && !user) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white w-full max-w-sm rounded-lg shadow-xl border border-slate-200 p-6 text-center">
          <Building2 size={36} className="text-cyan-600 mx-auto mb-3" />
          <h2 className="text-lg font-black text-slate-900 uppercase mb-2">Portal Khách Hàng</h2>
          <p className="text-sm text-slate-500 mb-4">Đăng nhập Google để xem dữ liệu</p>
          <button
            onClick={login}
            className="w-full py-3 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg text-sm font-black uppercase tracking-widest transition-all"
          >
            Đăng nhập Google
          </button>
        </div>
      </div>
    );
  }

  if (loading || authLoading) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-cyan-600" />
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white w-full max-w-sm rounded-lg shadow-xl border border-slate-200 p-6 text-center">
          <AlertCircle size={36} className="text-amber-500 mx-auto mb-3" />
          <p className="text-sm font-bold text-slate-700 mb-4">{error || 'Không tìm thấy khách hàng'}</p>
          <button onClick={() => window.location.href = '/'}
            className="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-black uppercase tracking-widest transition-all border border-slate-200">
            Về trang chủ
          </button>
        </div>
      </div>
    );
  }

  const tabs: { id: PortalTab; label: string; icon: React.ReactNode; count: number }[] = [
    { id: 'projects', label: 'Dự Án', icon: <Boxes size={16} />, count: modules.length },
    { id: 'packing', label: 'Đóng Gói', icon: <Package size={16} />, count: packingData.length },
    { id: 'loading', label: 'Lên Hàng', icon: <Truck size={16} />, count: loadingData.length },
  ];

  return (
    <div className="min-h-screen bg-slate-100 flex">
      {/* Sidebar */}
      <div className="w-64 bg-slate-900 text-white flex flex-col shrink-0 hidden lg:flex">
        <div className="p-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Building2 size={18} className="text-cyan-400" />
            <span className="text-sm font-black uppercase tracking-tight truncate">{customer.name}</span>
          </div>
          <p className="text-[10px] text-slate-500 mt-1">{customer.projectCodes.length} dự án</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); setSelectedModuleDetail(null); setSelectedModuleId(null); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-cyan-600 text-white'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'
              }`}
            >
              {tab.icon}
              <span className="text-xs font-black uppercase tracking-widest">{tab.label}</span>
              <span className="ml-auto text-[10px] font-black bg-white/10 px-1.5 py-0.5 rounded">{tab.count}</span>
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-slate-800">
          <button onClick={logout}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-all cursor-pointer">
            <LogOut size={16} />
            <span className="text-xs font-black uppercase tracking-widest">Đăng xuất</span>
          </button>
        </div>
      </div>

      {/* Mobile header + tabs */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="lg:hidden bg-white border-b border-slate-200 px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Building2 size={16} className="text-cyan-600" />
              <span className="text-sm font-black uppercase">{customer.name}</span>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setShowSettings(true)} className="p-2 text-slate-400 hover:text-slate-600 cursor-pointer">
                <Settings size={16} />
              </button>
              <button onClick={logout} className="p-2 text-slate-400 hover:text-slate-600 cursor-pointer">
                <LogOut size={16} />
              </button>
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); setSelectedModuleDetail(null); setSelectedModuleId(null); }}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest whitespace-nowrap transition-all cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-cyan-600 text-white'
                    : 'bg-slate-100 text-slate-500'
                }`}
              >
                {tab.icon}
                {tab.label}
                <span className="text-[9px] bg-white/20 px-1 rounded">{tab.count}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 p-4 overflow-auto">
          {activeTab === 'projects' && (
            <ProjectsTab
              modules={filteredModules}
              projectList={projectList}
              selectedProject={selectedProject}
              setSelectedProject={setSelectedProject}
              selectedModuleDetail={selectedModuleDetail}
              selectedModuleId={selectedModuleId}
              onRowClick={handleRowClick}
              setSelectedModuleId={setSelectedModuleId}
              setSelectedModuleDetail={setSelectedModuleDetail}
            />
          )}
          {activeTab === 'packing' && (
            <PackingTab data={packingData} />
          )}
          {activeTab === 'loading' && (
            <LoadingTab data={loadingData} />
          )}
        </div>
      </div>

      <GuestSettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />
    </div>
  );
}

// ── Projects Tab ──────────────────────────────────────────────

function ProjectsTab({
  modules, projectList, selectedProject, setSelectedProject,
  selectedModuleDetail, selectedModuleId, onRowClick,
  setSelectedModuleId, setSelectedModuleDetail
}: {
  modules: ProjectEntry[];
  projectList: { code: string; name: string }[];
  selectedProject: string | null;
  setSelectedProject: (v: string | null) => void;
  selectedModuleDetail: ProjectEntry | null;
  selectedModuleId: string | null;
  onRowClick: (e: ProjectEntry) => void;
  setSelectedModuleId: (id: string | null) => void;
  setSelectedModuleDetail: (m: ProjectEntry | null) => void;
}) {
  return (
    <div>
      {/* Project filter */}
      <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
        <button
          onClick={() => setSelectedProject(null)}
          className={`px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-widest whitespace-nowrap transition-all cursor-pointer ${
            !selectedProject ? 'bg-cyan-600 text-white' : 'bg-white text-slate-500 border border-slate-200'
          }`}
        >
          Tất cả ({modules.length})
        </button>
        {projectList.map(p => (
          <button
            key={p.code}
            onClick={() => setSelectedProject(p.code)}
            className={`px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-widest whitespace-nowrap transition-all cursor-pointer ${
              selectedProject === p.code ? 'bg-cyan-600 text-white' : 'bg-white text-slate-500 border border-slate-200'
            }`}
          >
            {p.code}
          </button>
        ))}
      </div>

      {/* Module list */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-100 border-b border-slate-200">
              <th className="py-2.5 px-4 text-left text-[10px] font-black text-slate-400 uppercase">#</th>
              <th className="py-2.5 px-4 text-left text-[10px] font-black text-slate-400 uppercase">Mã module</th>
              <th className="py-2.5 px-4 text-center text-[10px] font-black text-slate-400 uppercase">SL</th>
              <th className="py-2.5 px-4 text-center text-[10px] font-black text-slate-400 uppercase">QC</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {modules.map((entry, idx) => {
              const entryType = getEntryType(entry) as string;
              const isChild = (entry as any).isChild;
              const isSelected = selectedModuleDetail?.id === entry.id;
              const qcPass = ['white', 'paint', 'finish', 'pack'].every(s => {
                const agg = getModuleQcAggregate(entry, s as any);
                return agg?.status === 'pass';
              });
              const qcFail = ['white', 'paint', 'finish', 'pack'].some(s => {
                const agg = getModuleQcAggregate(entry, s as any);
                return agg?.status === 'fail';
              });
              return (
                <tr
                  key={`${entry.id}-${idx}`}
                  onClick={() => onRowClick(entry)}
                  className={`hover:bg-slate-50 transition-colors cursor-pointer ${isSelected ? 'bg-cyan-50 border-l-2 border-l-cyan-500' : ''}`}
                >
                  <td className="py-2 px-4 text-[10px] font-black text-slate-300">{idx + 1}</td>
                  <td className="py-2 px-4">
                    <div className="flex items-center gap-2">
                      {isChild && <span className="text-slate-300 font-mono text-[11px]">└──</span>}
                      <span className="text-sm font-black text-slate-900 uppercase">{entry.moduleCode}</span>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-center text-sm font-black text-slate-700">{entry.quantity || 0}</td>
                  <td className="py-2 px-4 text-center">
                    {qcPass ? <CheckCircle size={16} className="text-emerald-500 mx-auto" /> :
                     qcFail ? <XCircle size={16} className="text-red-500 mx-auto" /> :
                     <span className="text-[10px] text-slate-300">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {modules.length === 0 && (
          <div className="p-8 text-center">
            <Boxes size={32} className="text-slate-200 mx-auto mb-2" />
            <p className="text-sm text-slate-400">Không có modules</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Packing Tab ──────────────────────────────────────────────

function PackingTab({ data }: { data: any[] }) {
  if (data.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-12 text-center">
        <Package size={32} className="text-slate-200 mx-auto mb-2" />
        <p className="text-sm text-slate-400">Không có phiếu đóng gói</p>
      </div>
    );
  }
  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="bg-slate-100 border-b border-slate-200">
            <th className="py-2.5 px-4 text-left text-[10px] font-black text-slate-400 uppercase">Phiếu</th>
            <th className="py-2.5 px-4 text-left text-[10px] font-black text-slate-400 uppercase">Dự án</th>
            <th className="py-2.5 px-4 text-center text-[10px] font-black text-slate-400 uppercase">Trạng thái</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((item, idx) => (
            <tr key={item.id || idx} className="hover:bg-slate-50 transition-colors">
              <td className="py-2 px-4 text-sm font-black text-slate-900">{item.name || item.packingCode || item.id}</td>
              <td className="py-2 px-4 text-xs font-black text-slate-500 uppercase">{item.projectCode}</td>
              <td className="py-2 px-4 text-center">
                <span className={`text-[10px] font-black px-2 py-0.5 rounded ${
                  item.status === 'completed' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'
                }`}>
                  {item.status || 'Đang đóng gói'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Loading Tab ──────────────────────────────────────────────

function LoadingTab({ data }: { data: any[] }) {
  if (data.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-12 text-center">
        <Truck size={32} className="text-slate-200 mx-auto mb-2" />
        <p className="text-sm text-slate-400">Không có phiếu lên hàng</p>
      </div>
    );
  }
  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="bg-slate-100 border-b border-slate-200">
            <th className="py-2.5 px-4 text-left text-[10px] font-black text-slate-400 uppercase">Phiếu</th>
            <th className="py-2.5 px-4 text-left text-[10px] font-black text-slate-400 uppercase">Dự án</th>
            <th className="py-2.5 px-4 text-center text-[10px] font-black text-slate-400 uppercase">Trạng thái</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((item, idx) => (
            <tr key={item.id || idx} className="hover:bg-slate-50 transition-colors">
              <td className="py-2 px-4 text-sm font-black text-slate-900">{item.name || item.pklCode || item.id}</td>
              <td className="py-2 px-4 text-xs font-black text-slate-500 uppercase">{item.projectCode}</td>
              <td className="py-2 px-4 text-center">
                <span className={`text-[10px] font-black px-2 py-0.5 rounded ${
                  item.status === 'completed' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'
                }`}>
                  {item.status || 'Đang lên hàng'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
