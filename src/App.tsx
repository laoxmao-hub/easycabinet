/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Package, LogOut, Menu, X, TableIcon, Layers, Clock, BarChart3, Upload, Download, Boxes, Pencil, Users, Trash2, Save, User, FileText, Truck, ScanQrCode, Beaker, ClipboardCheck, SlidersHorizontal, MessageSquare, Bell, ListTodo, Printer, Loader2, AlertCircle, Globe, ChevronDown, Settings
} from 'lucide-react';
import {
  collection, query, orderBy, onSnapshot, doc, writeBatch, getDocs, getDoc, where, limit, updateDoc
} from 'firebase/firestore';
import { useAuth, AuthProvider } from './lib/AuthContext';
import { useLanguage } from './lib/LanguageContext';
import { db, handleFirestoreError, OperationType } from './lib/firebase';
import { setProjectEntriesCache } from './lib/dualWrite';
import { formatProjectCode } from './lib/formatters';

// Types
import {
  Tab, StockItem, ProjectEntry, UserProfile, ActivityFilter, BusinessNotification, getModuleQcAggregate
} from './types';

// Screens
import { PackingScreen } from './screens/PackingScreen';
import { LoadingScreen } from './screens/LoadingScreen';
import { ManagementScreen } from './screens/ProjectManagementScreen';
import { DeliveryReceiptScreen } from './screens/DeliveryReceiptScreen';
import { DeliveryListScreen } from './screens/DeliveryListScreen';
import { LoginScreen } from './screens/LoginScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { UserManagementScreen } from './screens/UserManagementScreen';
import { CustomersScreen } from './screens/CustomersScreen';
import { QuickScannerScreen } from './screens/QuickScannerScreen';
import { TestCodeScreen } from './screens/TestCodeScreen';
import { QCInspectionScreen } from './screens/QCInspectionScreen';
import { ToolsScreen } from './screens/ToolsScreen';
import { ExtensionsScreen } from './screens/ExtensionsScreen';
import { StatsScreen } from './screens/StatsScreen';
import { PlanningScreen } from './screens/PlanningScreen';
import { PrinterStationScreen } from './screens/PrinterStationScreen';

// Components
import { UserProfileModal } from './components/UserProfileModal';
import { PwaInstallPrompt } from './components/PwaInstallPrompt';
import { GuestSettingsModal } from './components/GuestSettingsModal';

function MainScreen() {
  const { user, logout, role, roles, hasRole, isGuest, guestProjectCodes, guestProjectCount, userProfile, loading: authLoading } = useAuth();
  const { lang, setLang, t } = useLanguage();
  const isAdmin = hasRole('admin');
  const [activeTab, setActiveTab] = useState<Tab>('stats');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedPackingId, setSelectedPackingId] = useState<string | null>(null);
  const [focusModuleName, setFocusModuleName] = useState<string | null>(null);
  const [focusInstanceIndex, setFocusInstanceIndex] = useState<number | null>(null);
  const [isPackingEditing, setIsPackingEditing] = useState(false);
  const [projectEntries, setProjectEntries] = useState<ProjectEntry[]>([]);
  const modulesLoadedRef = useRef(false);
  const completedModulesLoadedRef = useRef<Set<string>>(new Set());
  const [items, setItems] = useState<StockItem[]>([]);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [isSyncingData, setIsSyncingData] = useState(true);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [isBackgroundLoadingProjects, setIsBackgroundLoadingProjects] = useState(() => {
    // Nếu có cache → không cần chờ load → QR button hoạt động ngay
    try {
      const ts = Number(localStorage.getItem('draco_project_entries_ts') || 0);
      return !(Date.now() - ts <= 60 * 60 * 1000);
    } catch { return true; }
  });

  // Real-time navigation badges state
  const [qcTickets, setQcTickets] = useState<any[]>([]);
  // qcPendingCount is now computed via useMemo below
  const [packingPendingCount, setPackingPendingCount] = useState<number>(0);
  const [deliveryShipPendingCount, setDeliveryShipPendingCount] = useState<number>(0);
  const [exportPendingCount, setExportPendingCount] = useState<number>(0);

  // Real-time general notification states
  const [notifications, setNotifications] = useState<BusinessNotification[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState<number>(0);

  const [notifyDropdownOpen, setNotifyDropdownOpen] = useState(false);

  // --- localStorage cache cho badge counts ---
  const BADGE_CACHE_KEY = 'draco_badge_counts';
  const BADGE_TS_KEY = 'draco_badge_ts';
  const BADGE_CACHE_MAX_AGE = 30 * 60 * 1000;

  // Ref luôn giữ giá trị mới nhất — tránh stale closure khi ghi cache
  const badgeRef = useRef({
    packingPendingCount: 0,
    deliveryShipPendingCount: 0,
    exportPendingCount: 0,
    qcTickets: [] as any[],
    notifications: [] as BusinessNotification[],
  });

  const readBadgeCache = () => {
    try {
      const ts = Number(localStorage.getItem(BADGE_TS_KEY) || 0);
      if (Date.now() - ts > BADGE_CACHE_MAX_AGE) return null;
      const raw = localStorage.getItem(BADGE_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  };

  const flushBadgeCache = () => {
    try {
      localStorage.setItem(BADGE_CACHE_KEY, JSON.stringify(badgeRef.current));
      localStorage.setItem(BADGE_TS_KEY, String(Date.now()));
    } catch {}
  };

  // Load badge counts từ cache + packing cache ngay lập tức
  useEffect(() => {
    // 1. Badge counts cache
    const cached = readBadgeCache();
    if (cached) {
      if (cached.packingPendingCount != null) setPackingPendingCount(cached.packingPendingCount);
      if (cached.deliveryShipPendingCount != null) setDeliveryShipPendingCount(cached.deliveryShipPendingCount);
      if (cached.exportPendingCount != null) setExportPendingCount(cached.exportPendingCount);
      if (cached.qcTickets) setQcTickets(cached.qcTickets);
      if (cached.notifications) setNotifications(cached.notifications);
      badgeRef.current = { ...badgeRef.current, ...cached };
    }
    // 2. Packing cache — compute pending count từ danh sách đã cache
    try {
      const pTs = Number(localStorage.getItem('draco_packing_lists_ts') || 0);
      if (Date.now() - pTs <= BADGE_CACHE_MAX_AGE) {
        const raw = localStorage.getItem('draco_packing_lists_cache');
        if (raw) {
          const lists = JSON.parse(raw);
          const pendingCount = lists.filter((p: any) => !p.isCompleted).length;
          if (pendingCount > 0) {
            setPackingPendingCount(pendingCount);
            badgeRef.current.packingPendingCount = pendingCount;
          }
        }
      }
    } catch {}
  }, []);

  // Navigation states
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isDarkMode] = useState(false);
  const [showExtraMenu, setShowExtraMenu] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showGuestSettings, setShowGuestSettings] = useState(false);

  // Set default language based on guest/user on first load
  useEffect(() => {
    const saved = localStorage.getItem('app_language');
    if (isGuest) {
      localStorage.removeItem('app_language');
      setLang('en');
    } else if (!saved) {
      setLang('vi');
    }
  }, [isGuest]);

  // UI Selection states for Bulk Edits
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedModuleIds, setSelectedModuleIds] = useState<string[]>([]);
  const [showBulkModal, setShowBulkModal] = useState(false);

  // Remount/reset state for tabs on re-click
  const [resetKeys, setResetKeys] = useState<{ [key in Tab]?: number }>({});
  const [pendingQCAction, setPendingQCAction] = useState<{ moduleId: string; stageId: string } | null>(null);
  const [headerContent, setHeaderContent] = useState<{
    backButton?: React.ReactNode;
    title?: React.ReactNode;
    actions?: React.ReactNode;
  } | null>(null);

  const handleTabClick = (tabId: Tab) => {
    if (tabId === ('printer-station' as any)) {
      window.open(`${window.location.pathname}?printer_station=true`, '_blank');
      return;
    }
    if (activeTab === tabId) {
      setResetKeys(prev => ({
        ...prev,
        [tabId]: (prev[tabId] || 0) + 1
      }));
      setSelectedProject(null);
      setSelectedPackingId(null);
      setIsPackingEditing(false);
      setSelectedOrderId(null);
    } else {
      setActiveTab(tabId);
      setSelectedProject(null);
    }
  };


  useEffect(() => {
    document.documentElement.classList.remove('dark');
    localStorage.setItem('theme', 'light');
  }, []);

  // Lắng nghe sự kiện focus-packing-module từ QuickScannerScreen
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.moduleName) return;
      try {
        const snap = await getDocs(collection(db, 'packing'));
        for (const docSnap of snap.docs) {
          const data = docSnap.data();
          const items = data.items || [];
          const found = items.some((i: any) =>
            (i.name || '').toLowerCase().includes(detail.moduleName.toLowerCase()) ||
            (i.id || '').toLowerCase().includes(detail.moduleName.toLowerCase())
          );
          if (found) {
            // Set cả 3 state cùng lúc để React render 1 lần
            setSelectedPackingId(docSnap.id);
            setFocusModuleName(detail.moduleName);
            setFocusInstanceIndex(detail.instanceIndex ?? null);
            setActiveTab('packing');
            return;
          }
        }
        alert('Không tìm thấy phiếu đóng gói chứa module này!');
      } catch (err) {
        console.error('Error finding packing list:', err);
      }
    };
    window.addEventListener('focus-packing-module', handler);
    return () => window.removeEventListener('focus-packing-module', handler);
  }, []);

  useEffect(() => {
    if (!user) return;

    // Các listener phụ (badge, thông báo, items...) được trì hoãn ~1.5s
    // để dành toàn bộ băng thông cho luồng load modules chính lúc khởi động.
    const unsubs: (() => void)[] = [];
    const deferTimer = setTimeout(() => {
      // Tải danh sách user 1 lần duy nhất để hạn chế quota Firestore reads
      getDocs(collection(db, 'users')).then((snapshot) => {
        setAllUsers(snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() } as UserProfile)));
      }).catch((err) => {
        console.error("Error fetching users list:", err);
        handleFirestoreError(err, OperationType.LIST, 'users');
      });

      const qItems = query(collection(db, 'items'), orderBy('createdAt', 'desc'), limit(500));
      const unsubItems = onSnapshot(qItems, (snapshot) => {
        setItems(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as StockItem)));
      }, (err) => {
        handleFirestoreError(err, OperationType.GET, 'items');
      });
      unsubs.push(unsubItems);

      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

      const qQcTickets = query(
        collection(db, 'qc_tickets'),
        where('createdAt', '>=', sixtyDaysAgo)
      );
      const unsubQcTickets = onSnapshot(qQcTickets, (snapshot) => {
        const tickets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setQcTickets(tickets);
        badgeRef.current.qcTickets = tickets;
        flushBadgeCache();
      }, (error) => {
        console.warn("Lỗi đồng bộ qc_tickets:", error);
      });
      unsubs.push(unsubQcTickets);

      const qPacking = query(collection(db, 'packing'), where('isCompleted', '==', false));
      const unsubPacking = onSnapshot(qPacking, (snapshot) => {
        const count = isGuest && guestProjectCount > 0
          ? guestProjectCount
          : snapshot.size;
        setPackingPendingCount(count);
        badgeRef.current.packingPendingCount = count;
        flushBadgeCache();
      }, (error) => {
        console.warn("Lỗi đồng bộ packing:", error);
      });
      unsubs.push(unsubPacking);

      const qShipping = query(
        collection(db, 'shipping_orders'),
        where('type', '==', 'ship')
      );
      const unsubShipping = onSnapshot(qShipping, (snapshot) => {
        const pendingCount = snapshot.docs.filter(d => d.data().status !== 'completed').length;
        setDeliveryShipPendingCount(pendingCount);
        badgeRef.current.deliveryShipPendingCount = pendingCount;
        flushBadgeCache();
      }, (error) => {
        console.warn("Lỗi đồng bộ shipping_orders:", error);
      });
      unsubs.push(unsubShipping);

      const qProposals = query(collection(db, 'export_proposals'), where('status', '==', 'pending'));
      const unsubProposals = onSnapshot(qProposals, (snapshot) => {
        setExportPendingCount(snapshot.size);
        badgeRef.current.exportPendingCount = snapshot.size;
        flushBadgeCache();
      }, (error) => {
        console.warn("Lỗi đồng bộ export_proposals:", error);
      });
      unsubs.push(unsubProposals);

      // Lắng nghe thông báo nghiệp vụ (giới hạn 150 thông báo mới nhất)
      const qNotif = query(collection(db, 'notifications'), orderBy('createdAt', 'desc'), limit(150));
      const unsubNotif = onSnapshot(qNotif, (snapshot) => {
        const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as BusinessNotification));
        setNotifications(list);
        badgeRef.current.notifications = list;
        flushBadgeCache();
      }, (error) => {
        console.warn("Lỗi đồng bộ notifications:", error);
      });
      unsubs.push(unsubNotif);
    }, 1500);

    return () => {
      clearTimeout(deferTimer);
      unsubs.forEach(u => u());
    };
  }, [user]);

  // === projectConfigs: load modules on-demand ===
  const tabsWithoutModules: Tab[] = ['users', 'test-code', 'tools'];

  // --- localStorage cache helpers ---
  const PROJECT_CACHE_KEY = 'draco_project_entries_cache';
  const PROJECT_CACHE_TS_KEY = 'draco_project_entries_ts';
  const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes

  const readCache = (): ProjectEntry[] | null => {
    try {
      const ts = Number(localStorage.getItem(PROJECT_CACHE_TS_KEY) || 0);
      if (Date.now() - ts > CACHE_MAX_AGE_MS) return null;
      const raw = localStorage.getItem(PROJECT_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw, (_key, val) => {
        // Restore Date objects from ISO strings
        if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) {
          return new Date(val);
        }
        return val;
      });
    } catch { return null; }
  };

  const writeCache = (entries: ProjectEntry[]) => {
    try {
      localStorage.setItem(PROJECT_CACHE_KEY, JSON.stringify(entries));
      localStorage.setItem(PROJECT_CACHE_TS_KEY, String(Date.now()));
    } catch { /* quota exceeded, ignore */ }
  };

  useEffect(() => {
    // Guest: chờ auth xác định guestProjectCodes xong mới load
    if (isGuest && guestProjectCodes.length === 0) {
      return;
    }

    if (modulesLoadedRef.current || tabsWithoutModules.includes(activeTab)) {
      if (modulesLoadedRef.current) {
        setIsSyncingData(false);
        setLoading(false);
      }
      return;
    }

    // ─── LUỒNG GUEST: load configs trước → hiện danh sách → load modules dần ───
    if (isGuest && guestProjectCodes.length > 0) {
      const loadGuest = async () => {
        modulesLoadedRef.current = true;
        try {
          const codes = guestProjectCodes.slice(0, 30);
          const configsSnap = await getDocs(
            query(collection(db, 'projectConfigs'), where('projectCode', 'in', codes))
          );
          if (configsSnap.empty) { setIsSyncingData(false); setLoading(false); return; }

          // Bước 1: Tạo placeholder từ configs — hiển thị danh sách ngay lập tức
          const placeholders: ProjectEntry[] = configsSnap.docs.map(configDoc => {
            const config = configDoc.data();
            return {
              id: `placeholder-${configDoc.id}`,
              configId: configDoc.id,
              projectName: config.projectName || '',
              projectCode: config.projectCode || '',
              projectOrder: config.projectOrder,
              cluster: '',
              moduleCode: '',
              quantity: 0,
              ownerId: '',
              createdAt: config.createdAt,
              isCompleted: config.isCompleted || false,
              completedAt: config.completedAt,
              glbUrl: config.glbUrl || '',
              drawingUrl: config.drawingUrl || '',
              assemblyDrawingUrl: config.assemblyDrawingUrl || '',
            } as ProjectEntry;
          });

          setProjectEntries(placeholders);
          setProjectEntriesCache(placeholders);
          setIsSyncingData(false);
          setLoading(false);
          setIsBackgroundLoadingProjects(true);

          // Bước 2: Load modules từng project ở nền, cập nhật dần
          let currentEntries = [...placeholders];
          for (const configDoc of configsSnap.docs) {
            const config = configDoc.data();
            const configId = configDoc.id;
            try {
              const modulesSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
              const moduleEntries: ProjectEntry[] = modulesSnap.docs.map(modDoc => ({
                ...modDoc.data(),
                id: modDoc.id,
                configId,
                projectName: config.projectName || '',
                projectCode: config.projectCode || '',
                projectOrder: config.projectOrder,
                glbUrl: config.glbUrl || '',
                drawingUrl: config.drawingUrl || '',
                assemblyDrawingUrl: config.assemblyDrawingUrl || '',
                isCompleted: config.isCompleted || false,
                completedAt: config.completedAt,
              } as ProjectEntry));

              // Cập nhật: thay placeholder bằng modules thật
              currentEntries = [...currentEntries.filter(e => e.configId !== configId), ...moduleEntries];
              setProjectEntries(currentEntries);
              setProjectEntriesCache(currentEntries);
            } catch {
              // Load modules fail — giữ nguyên placeholder
            }
          }

          console.log(`[App] Guest loaded all project modules`);
          setIsBackgroundLoadingProjects(false);
        } catch (err) {
          console.error('[App] Guest load failed:', err);
          setIsSyncingData(false);
          setLoading(false);
        }
      };
      loadGuest();
      return;
    }

    // ─── LUỒNG USER: cache-first → background refresh ───
    const doLoad = async () => {
      modulesLoadedRef.current = true;

      // Bước 1: Hiển thị từ cache ngay lập tức (nếu có)
      const cached = readCache();
      if (cached && cached.length > 0) {
        setProjectEntries(cached);
        setProjectEntriesCache(cached);
        setIsSyncingData(false);
        setLoading(false);
        console.log(`[App] Loaded ${cached.length} entries from cache (instant)`);
      }

      try {
        const loadStart = Date.now();

        // Bước 2: Fetch fresh data từ Firestore
        // Chỉ tải configs trước — KHÔNG tải toàn bộ modules (kể cả modules của
        // projects hoàn tất) như trước đây. Modules của projects hoàn tất được load
        // on-demand khi người dùng mở project đó → giảm ~40% payload khởi động.
        const configsSnap = await getDocs(collection(db, 'projectConfigs'));
        if (configsSnap.empty) {
          if (!cached || cached.length === 0) {
            setProjectEntries([]);
            setIsSyncingData(false);
            setLoading(false);
          }
          return;
        }

        // Build config lookup
        const configMap = new Map<string, any>();
        const activeConfigs: { doc: any; data: any }[] = [];
        const completedConfigs: { doc: any; data: any }[] = [];

        configsSnap.docs.forEach(configDoc => {
          const config = configDoc.data();
          configMap.set(configDoc.id, config);
          if (config.isCompleted) {
            completedConfigs.push({ doc: configDoc, data: config });
          } else {
            activeConfigs.push({ doc: configDoc, data: config });
          }
        });

        // Fetch modules cho ACTIVE projects — song song theo batch để tránh quá tải kết nối.
        // Không tải modules của projects hoàn tất (load on-demand khi mở project đó).
        const MODULE_BATCH_SIZE = 10;
        const allResults: { status: 'fulfilled'; value: ProjectEntry[] }[] = [];
        for (let i = 0; i < activeConfigs.length; i += MODULE_BATCH_SIZE) {
          const batch = activeConfigs.slice(i, i + MODULE_BATCH_SIZE);
          const batchResults = await Promise.allSettled(
            batch.map(async ({ doc: configDoc, data: config }) => {
              const configId = configDoc.id;
              const modulesSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
              return modulesSnap.docs.map(modDoc => ({
                ...modDoc.data(),
                id: modDoc.id,
                configId,
                projectName: config.projectName || '',
                projectCode: config.projectCode || '',
                projectOrder: config.projectOrder,
                glbUrl: config.glbUrl || '',
                drawingUrl: config.drawingUrl || '',
                assemblyDrawingUrl: config.assemblyDrawingUrl || '',
                isCompleted: false,
              } as ProjectEntry));
            })
          );
          batchResults.forEach(r => { if (r.status === 'fulfilled') allResults.push(r); });
        }
        const activeModules: ProjectEntry[] = allResults.flatMap(r => r.value);

        // Projects hoàn tất: tạo metadata placeholder
        const completedModules: ProjectEntry[] = completedConfigs.map(({ doc: configDoc, data: config }) => ({
          id: `completed-${configDoc.id}`,
          configId: configDoc.id,
          projectName: config.projectName || '',
          projectCode: config.projectCode || '',
          projectOrder: config.projectOrder,
          cluster: '',
          moduleCode: '',
          quantity: 0,
          ownerId: '',
          createdAt: config.createdAt,
          isCompleted: true,
          completedAt: config.completedAt,
          glbUrl: config.glbUrl || '',
          drawingUrl: config.drawingUrl || '',
          assemblyDrawingUrl: config.assemblyDrawingUrl || '',
        } as ProjectEntry));

        const allModules = [...activeModules, ...completedModules];
        const elapsed = ((Date.now() - loadStart) / 1000).toFixed(1);
        console.log(`[App] Loaded ${activeModules.length} active + ${completedModules.length} completed modules in ${elapsed}s`);
        setProjectEntries(allModules);
        setProjectEntriesCache(allModules);
        writeCache(allModules);
        setIsSyncingData(false);
        setLoading(false);

        // Projects hoàn tất: giữ placeholder (metadata từ configs) — không tải modules ngay.
        // Modules thật được load on-demand khi người dùng mở project hoàn tất
        // (xem effect `On-demand: load modules của project hoàn tất` phía dưới).
        setIsBackgroundLoadingProjects(false);
      } catch (err) {
        console.error('[App] Failed to load modules:', err);
        // Nếu có cache thì giữ nguyên UI, chỉ ẩn loading bar
        if (!cached || cached.length === 0) {
          setIsSyncingData(false);
          setLoading(false);
        } else {
          setIsSyncingData(false);
          setLoading(false);
        }
      }
    };
    doLoad();
  }, [activeTab, isGuest, guestProjectCodes]);

  // === On-demand: load modules của project hoàn tất khi người dùng mở nó ===
  const loadCompletedProject = useCallback(async (configId: string, fallback: ProjectEntry) => {
    if (completedModulesLoadedRef.current.has(configId)) return;
    completedModulesLoadedRef.current.add(configId);
    try {
      const modulesSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
      const moduleEntries: ProjectEntry[] = modulesSnap.docs.map(modDoc => ({
        ...modDoc.data(),
        id: modDoc.id,
        configId,
        projectName: fallback.projectName || '',
        projectCode: fallback.projectCode || '',
        projectOrder: fallback.projectOrder,
        glbUrl: fallback.glbUrl || '',
        drawingUrl: fallback.drawingUrl || '',
        assemblyDrawingUrl: fallback.assemblyDrawingUrl || '',
        isCompleted: true,
        completedAt: fallback.completedAt,
      } as ProjectEntry));

      if (moduleEntries.length === 0) return;

      // Functional updater — tránh ghi đè state mới hơn khi có fetch khác xen vào
      setProjectEntries(prev => {
        const merged = [...prev.filter(e => e.id !== `completed-${configId}`), ...moduleEntries];
        writeCache(merged);
        setProjectEntriesCache(merged);
        return merged;
      });
      console.log(`[App] On-demand loaded ${moduleEntries.length} modules for completed project "${fallback.projectCode}"`);
    } catch (err) {
      console.warn('[App] On-demand load completed project modules failed:', err);
      completedModulesLoadedRef.current.delete(configId); // cho phép thử lại lần sau
    }
  }, []);

  // Dùng chung cho các screen (Management, Packing, ...) khi user mở project hoàn tất
  const handleOpenCompletedProject = useCallback((projectCode: string) => {
    const placeholder = projectEntries.find(
      e => e.isCompleted && e.projectCode === projectCode && e.id.startsWith('completed-')
    );
    if (placeholder?.configId) {
      loadCompletedProject(placeholder.configId, placeholder);
    }
  }, [projectEntries, loadCompletedProject]);

  // App-level: mở project hoàn tất từ tab Dự Án (Management)
  useEffect(() => {
    if (selectedProject) {
      handleOpenCompletedProject(selectedProject);
    }
  }, [selectedProject, handleOpenCompletedProject]);

  // === Real-time sync: onSnapshot projectConfigs ===
  const skipInitialSnapshotRef = useRef(true);
  const pendingConfigUpdatesRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    // Guest: chỉ listen thay đổi cho projects của mình
    const configsRef = (isGuest && guestProjectCodes.length > 0)
      ? query(collection(db, 'projectConfigs'), where('projectCode', 'in', guestProjectCodes.slice(0, 30)))
      : collection(db, 'projectConfigs');

    const unsubscribe = onSnapshot(
      configsRef,
      (snapshot) => {
        // Skip initial snapshot — đã load bằng getDocs ở trên
        if (skipInitialSnapshotRef.current) {
          skipInitialSnapshotRef.current = false;
          return;
        }

        snapshot.docChanges().forEach((change) => {
          if (change.type !== 'modified') return;

          const configId = change.doc.id;
          const configData = change.doc.data();

          // Bỏ qua completed projects
          if (configData.isCompleted) return;

          // Debounce 300ms — gộp nhiều thay đổi liên tiếp
          const existing = pendingConfigUpdatesRef.current.get(configId);
          if (existing) clearTimeout(existing);

          pendingConfigUpdatesRef.current.set(configId, setTimeout(async () => {
            pendingConfigUpdatesRef.current.delete(configId);
            try {
              const modulesSnap = await getDocs(
                collection(db, 'projectConfigs', configId, 'modules')
              );
              const modules = modulesSnap.docs.map(modDoc => ({
                ...modDoc.data(),
                id: modDoc.id,
                configId,
                projectName: configData.projectName || '',
                projectCode: configData.projectCode || '',
                projectOrder: configData.projectOrder,
                glbUrl: configData.glbUrl || '',
                drawingUrl: configData.drawingUrl || '',
                assemblyDrawingUrl: configData.assemblyDrawingUrl || '',
                isCompleted: false,
              } as ProjectEntry));

              setProjectEntries(prev => {
                const filtered = prev.filter(e => e.configId !== configId && e.id !== `completed-${configId}`);
                const merged = [...filtered, ...modules];
                writeCache(merged);
                return merged;
              });
              setProjectEntriesCache([
                ...projectEntries.filter(e => e.configId !== configId && e.id !== `completed-${configId}`),
                ...modules,
              ]);
            } catch (err) {
              console.warn('[App] Real-time sync failed for config:', configId, err);
            }
          }, 300));
        });
      },
      (error) => {
        console.warn('[App] projectConfigs onSnapshot error:', error);
      }
    );

    return () => unsubscribe();
  }, [isGuest, guestProjectCodes]);

  // Danh sách projects đang hoạt động (loại bỏ projects hoàn tất) cho các screen xử lý data
  const activeProjectEntries = useMemo(() => {
    let entries = projectEntries.filter(pe => !pe.isCompleted);
    // Guest: chỉ xem projects được giao
    if (isGuest && guestProjectCodes.length > 0) {
      entries = entries.filter(pe => guestProjectCodes.includes(pe.projectCode));
    }
    return entries;
  }, [projectEntries, isGuest, guestProjectCodes]);

  // Guest: filter projectEntries theo projectCodes
  const filteredProjectEntries = useMemo(() => {
    if (isGuest && guestProjectCodes.length > 0) {
      return projectEntries.filter(pe => guestProjectCodes.includes(pe.projectCode));
    }
    return projectEntries;
  }, [projectEntries, isGuest, guestProjectCodes]);

  // Cập nhật trạng thái hoạt động định kỳ của người dùng để hiển thị online/offline
  useEffect(() => {
    if (!user) return;

    const updateUserActiveStatus = async () => {
      try {
        await updateDoc(doc(db, 'users', user.uid), {
          lastActive: new Date()
        });
      } catch (e) {
        console.warn("Lỗi cập nhật trạng thái hoạt động:", e);
      }
    };

    // Cập nhật ngay khi mở app
    updateUserActiveStatus();

    // Cập nhật mỗi 60 giây một lần để đảm bảo báo hiệu online trung thực
    const intervalRef = setInterval(updateUserActiveStatus, 60000);

    return () => clearInterval(intervalRef);
  }, [user]);

  // Bộ lọc thông báo của riêng tôi
  const myNotifications = notifications.filter(n => {
    if (!user) return false;
    const matchUser = n.targetUsers && n.targetUsers.includes(user.uid);
    const matchRole = n.targetRoles && (
      roles.some(r => n.targetRoles!.includes(r)) ||
      n.targetRoles.includes(userProfile?.chuc_danh || '')
    );
    const isGeneral = (!n.targetUsers || n.targetUsers.length === 0) && (!n.targetRoles || n.targetRoles.length === 0);
    return matchUser || matchRole || isGeneral;
  });

  const unreadNotifications = myNotifications.filter(n => !n.readBy || !n.readBy.includes(user?.uid || ''));

  // Bộ đếm thông báo chưa đọc
  useEffect(() => {
    if (!user) return;
    const count = unreadNotifications.length;
    if (unreadNotificationCount !== count) {
      setUnreadNotificationCount(count);
    }
  }, [notifications, user, userProfile, unreadNotificationCount, unreadNotifications.length]);

  // Yêu cầu quyền Notification của trình duyệt để có thể hiển thị thông báo nổi bất cứ lúc nào
  useEffect(() => {
    if (!user) return;
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, [user]);

  // Lắng nghe thông báo mới để gửi thông báo nổi trực tiếp trên PC/Mobile
  const lastNotifCountRef = useRef<number>(-1);
  useEffect(() => {
    if (!user || myNotifications.length === 0) return;

    // Khởi tạo số lượng ban đầu lần đầu load để tránh đẩy thông báo dồn dập của quá khứ
    if (lastNotifCountRef.current === -1) {
      lastNotifCountRef.current = myNotifications.length;
      return;
    }

    if (myNotifications.length > lastNotifCountRef.current) {
      const latestNotif = myNotifications[0]; // thông báo mới nhất do orderBy desc

      if ('Notification' in window && Notification.permission === 'granted') {
        const notif = new Notification(latestNotif.title, {
          body: latestNotif.content,
          icon: 'https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782285783/logo_app_va9ksb.png',
        });
        notif.onclick = () => {
          window.focus();
        };
      }
    }
    lastNotifCountRef.current = myNotifications.length;
  }, [myNotifications, user]);

  const qcPendingCount = useMemo(() => {
    const STAGES = [
      { id: 'white', field: 'qcWhite' },
      { id: 'paint', field: 'qcPaint' },
      { id: 'finish', field: 'qcFinish' },
      { id: 'pack', field: 'qcPack' },
    ] as const;

    // Build Map for O(1) lookup thay vì .find() O(N)
    const moduleMap = new Map<string, ProjectEntry>();
    projectEntries.forEach(pe => {
      moduleMap.set(pe.id, pe);
      if (pe.moduleCode) moduleMap.set(pe.moduleCode, pe);
    });

    let pendingCount = 0;

    qcTickets.forEach(ticket => {
      const stage = STAGES.find(s => s.id === ticket.stage);
      if (!stage) return;

      const seenIds = new Set<string>();
      const resolvedModules: any[] = [];

      (ticket.modules || []).forEach((m: any) => {
        if (!m?.id || seenIds.has(m.id)) return;
        seenIds.add(m.id);

        const projectModule = moduleMap.get(m.id) || moduleMap.get(m.moduleCode);
        if (!projectModule) return;

        const qcAgg = getModuleQcAggregate(projectModule, stage.id as any);
        const currentRealStatus = qcAgg?.status || 'pending';

        resolvedModules.push({
          ...m,
          status: currentRealStatus,
          quantity: projectModule.quantity || m.quantity || 1,
          passedQty: currentRealStatus === 'pass' ? (projectModule.quantity || 1) : (m.passedQty || 0),
        });
      });

      if (resolvedModules.length === 0) return;

      const totalModules = resolvedModules.reduce((sum: number, m: any) => sum + (m.quantity || 1), 0);
      const passModules = resolvedModules.reduce((sum: number, m: any) => {
        if (m.status === 'pass') return sum + (m.quantity || 1);
        return sum + (m.passedQty || 0);
      }, 0);
      const failModules = resolvedModules.filter((m: any) => m.status === 'fail').reduce((sum: number, m: any) => sum + (m.quantity || 1), 0);
      const inspectedCount = passModules + failModules;

      const hasPendingModules = resolvedModules.some((m: any) => m.status === 'pending' || m.status === 'none');
      const isTicketCompleted = ticket.status === 'completed' || (!hasPendingModules && inspectedCount === totalModules);

      if (!isTicketCompleted) {
        pendingCount++;
      }
    });

    return pendingCount;
  }, [qcTickets, projectEntries]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('orderId');
    if (orderId) {
      setActiveTab('delivery');
      setSelectedOrderId(orderId);
      // Clear the param after reading to avoid re-triggering if tab changes
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    setIsSelectMode(false);
    setSelectedModuleIds([]);
    setSelectedPackingId(null);
    setIsPackingEditing(false);
    if (activeTab !== 'delivery') {
      setSelectedOrderId(null);
    }
  }, [selectedProject, activeTab]);

  useEffect(() => {
    // Check for hidden test-code page via URL query or path
    const params = new URLSearchParams(window.location.search);
    const path = window.location.pathname;
    if ((params.get('page') === 'testcode' || path === '/testcode') && isAdmin) {
      setActiveTab('test-code');
      // If accessed via path, clean it up or keep it? User wants to access from it.
      // Usually in SPA we'd keep it, but the app uses state.
    }
  }, [isAdmin]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const path = window.location.pathname;
    if (path === '/tools' || params.get('page') === 'tools') {
      setActiveTab('tools');
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('printer_station') === 'true') {
      setActiveTab('printer-station' as any);
    }
  }, []);

  const menuItems = useMemo(() => [
    { id: 'stats', labelKey: 'Thống Kê', icon: <BarChart3 size={20} />, color: 'bg-indigo-600', roles: ['admin', 'member', 'mod_x1', 'mod_x2', 'mod_qc'] },
    { id: 'planning', labelKey: 'Kế Hoạch', icon: <ListTodo size={20} />, color: 'bg-emerald-600', roles: ['admin', 'member', 'mod_x1', 'mod_x2', 'mod_qc'] },
    { id: 'management', labelKey: 'Dự Án', icon: <Layers size={20} />, color: 'bg-blue-500', roles: ['admin', 'member', 'mod_x1', 'mod_x2', 'mod_qc'] },
    { id: 'delivery', labelKey: 'Giao Nhận', icon: <Truck size={20} />, color: 'bg-amber-500', roles: ['admin', 'mod_x1', 'mod_x2', 'mod_qc'] },
    { id: 'qc', labelKey: 'Kiểm Hàng', icon: <ClipboardCheck size={20} />, color: 'bg-indigo-600', roles: ['admin', 'mod_x1', 'mod_x2', 'mod_qc'] },
    { id: 'scanner', labelKey: 'Quét QR', icon: <ScanQrCode size={20} />, color: 'bg-cyan-500', mobileOnly: true, roles: ['admin', 'member', 'mod_x1', 'mod_x2', 'mod_qc'] },
    { id: 'packing', labelKey: 'Đóng Gói', icon: <Package size={20} />, color: 'bg-purple-500', roles: ['admin', 'member', 'mod_x1', 'mod_x2', 'mod_qc'] },
    { id: 'loading', labelKey: 'Lên Hàng', icon: <Truck size={20} />, color: 'bg-purple-500', roles: ['admin', 'member', 'mod_x1', 'mod_x2', 'mod_qc'] },
    { id: 'inventory', labelKey: 'Kho Hàng', icon: <Boxes size={20} />, color: 'bg-orange-500', roles: ['admin', 'mod_x2'] },
    { id: 'users', labelKey: 'Nhân Sự', icon: <Users size={20} />, color: 'bg-red-500', roles: ['admin'] },
    { id: 'customers', labelKey: 'Tài Khoản', icon: <Users size={20} />, color: 'bg-cyan-600', roles: ['admin', 'mod_x1', 'mod_x2'] },
    { id: 'extensions', labelKey: 'Mở rộng', icon: <Beaker size={20} />, color: 'bg-emerald-600', roles: ['admin', 'member', 'mod_x1', 'mod_x2', 'mod_qc'] },
    { id: 'printer-station', labelKey: 'Trạm In', icon: <Printer size={20} />, color: 'bg-emerald-500', roles: ['admin'] },
  ], []);

  // Lọc id 'management', 'scanner', 'qc' ra khỏi filteredMenuItems để cố định vị trí hiển thị
  const fixedMenuIds = ['management', 'scanner', 'qc'];
  const fixedMenuItems = menuItems.filter(item => fixedMenuIds.includes(item.id));
  // filteredMenuItems sẽ không chứa các mục đã cố định, và sẽ được sắp xếp theo roles
  const remainingMenuItems = menuItems.filter(item => !fixedMenuIds.includes(item.id));
  const filteredMenuItems = remainingMenuItems.filter(item => {
    return (item.roles as readonly string[]).some(r => roles.includes(r));
  });
  const filteredMenuItems0 = menuItems.filter(item => {
    return (item.roles as readonly string[]).some(r => roles.includes(r));
  });

  // Guest: chỉ cho phép xem Dự án, Đóng gói
  const guestAllowedTabs = ['management', 'packing'];
  const guestFilteredMenuItems = isGuest
    ? menuItems.filter(item => guestAllowedTabs.includes(item.id))
    : filteredMenuItems0;

  // Default redirect if current tab is not allowed
  useEffect(() => {
    const menuItem = menuItems.find(i => i.id === activeTab) as any;
    const currentRoles = menuItem?.roles;
    const isMobileOnly = menuItem?.mobileOnly;
    const isPC = window.innerWidth >= 1024;

    // Guest: chỉ check tabs trong guestAllowedTabs
    if (isGuest && guestAllowedTabs.includes(activeTab as string)) {
      return;
    }

    if (!loading && role && (
      (currentRoles && !(currentRoles as readonly string[]).some(r => roles.includes(r))) ||
      (isMobileOnly && isPC)
    )) {
      setActiveTab('management');
    }
  }, [role, loading, activeTab]);

  useEffect(() => {
    // Auto collapse sidebar on mobile
    const handleResize = () => {
      if (window.innerWidth < 1024) setSidebarOpen(false);
      else setSidebarOpen(true);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const getBadgeCount = (id: string) => {
    if (id === 'management') return isGuest ? guestProjectCount : 0;
    if (id === 'qc') return qcPendingCount;
    if (id === 'packing') return packingPendingCount;
    if (id === 'loading') return isGuest ? guestProjectCount : 0;
    if (id === 'delivery') return deliveryShipPendingCount;
    if (id === 'inventory') return exportPendingCount;
    return 0;
  };

  return (
    <div className="h-screen flex flex-col lg:flex-row font-sans overflow-hidden" id="main-screen">
      {/* PC Sidebar */}
      <aside
        className={`${sidebarOpen ? 'w-64' : 'w-0 lg:w-20'} bg-slate-900 text-slate-400 transition-all duration-300 ease-in-out flex-col hidden lg:flex h-screen sticky top-0 z-100 border-r border-slate-800`}
        id="pc-sidebar"
      >
        <div className="h-16 flex items-center px-4 border-b border-slate-800 overflow-hidden shrink-0">
          <div className="flex items-center space-x-3 min-w-[200px] cursor-pointer" onClick={() => handleTabClick('management')}>
            <img
              src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1784541482/logo-easycabinet-transparent-b_ixkuet.png"
              alt="Logo"
              className="object-contain shrink-0"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-4 scrollbar-hide">
          {/* Sidebar Profiler */}
          <div
            onClick={() => setShowProfileModal(true)}
            className={`px-4 mb-6 border-b border-slate-800 pb-6 flex items-center hover:bg-slate-800/50 transition-colors cursor-pointer ${sidebarOpen ? 'space-x-3' : 'justify-center'}`}
          >
            <div className="relative shrink-0">
              {user?.photoURL ? (
                <img src={user.photoURL} alt="User" className="w-8 h-8 rounded-full border border-slate-700" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 border border-slate-700">
                  <User size={16} />
                </div>
              )}
            </div>
            {sidebarOpen && (
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-bold text-slate-200 truncate">{isGuest ? (userProfile?.name || t('Khách')) : (userProfile?.ten_that || user?.displayName)}</span>
                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-black">{isGuest ? t('Khách hàng') : (userProfile?.chuc_danh || 'Admin')}</span>
              </div>
            )}
          </div>

          <nav className="px-2 space-y-1">
            {guestFilteredMenuItems.filter(item => !(item as any).mobileOnly).map((item) => {
              const badgeCount = getBadgeCount(item.id);
              return (
                <button
                  key={item.id}
                  onClick={() => handleTabClick(item.id as Tab)}
                  className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg transition-all group ${activeTab === item.id
                    ? 'bg-indigo-600 text-white'
                    : 'hover:bg-slate-800 text-slate-100 hover:text-slate-200'
                    }`}
                  title={t(item.labelKey)}
                >
                  <div className={`${sidebarOpen ? '' : 'mx-auto relative'} shrink-0`}>
                    {item.icon}
                    {!sidebarOpen && badgeCount > 0 && (
                      <span className={`absolute -top-1.5 -right-1.5 text-[8px] font-black w-4 h-4 rounded-full flex items-center justify-center border border-slate-900 ${isGuest ? 'bg-slate-500 text-white' : 'bg-rose-500 text-white animate-pulse'}`}>
                        {badgeCount}
                      </span>
                    )}
                  </div>
                  {sidebarOpen && (
                    <div className="flex items-center justify-between flex-1 min-w-0">
                      <span className="text-sm font-black uppercase tracking-tight truncate">{t(item.labelKey)}</span>
                      {badgeCount > 0 && (
                        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-lg leading-none shrink-0 ml-1 ${isGuest ? 'bg-slate-600 text-slate-300' : 'bg-rose-500 text-white'}`}>
                          {badgeCount}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

          {/* Language Switcher */}
          <div className="px-3 pb-4 shrink-0">
            <div className="relative group">
              <button className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-all cursor-pointer">
                <Globe size={16} />
                {sidebarOpen && (
                  <>
                    <span className="text-xs font-black uppercase tracking-widest flex-1 text-left">{lang === 'en' ? 'English' : 'Tiếng Việt'}</span>
                    <ChevronDown size={12} />
                  </>
                )}
              </button>
              <div className="absolute left-0 bottom-full mb-1 bg-white rounded-lg border border-slate-200 shadow-xl z-50 overflow-hidden opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all min-w-[120px]">
                <button
                  onClick={() => setLang('en')}
                  className={`w-full px-3 py-2 text-[10px] font-black uppercase tracking-widest text-left transition-colors cursor-pointer flex items-center gap-2 ${lang === 'en' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  🇬🇧 English
                </button>
                <button
                  onClick={() => setLang('vi')}
                  className={`w-full px-3 py-2 text-[10px] font-black uppercase tracking-widest text-left transition-colors cursor-pointer flex items-center gap-2 ${lang === 'vi' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  🇻🇳 Tiếng Việt
                </button>
              </div>
            </div>
          </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden relative bg-slate-100 transition-colors duration-300">
        {/* Thanh loading mỏng trên cùng màn hình */}
        {isSyncingData && (
          <div className="fixed top-0 left-0 right-0 h-[3px] z-[60] pointer-events-none">
            <div className="h-full w-full relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-[40%] bg-gradient-to-r from-indigo-500 via-indigo-400 to-indigo-600 loading-bar-slide shadow-[0_0_8px_rgba(99,102,241,0.5)]" />
            </div>
          </div>
        )}
        <header
          className="bg-slate-800 md:bg-white border-b border-slate-200 h-16 flex items-center justify-between px-4 sticky top-0 z-[40] shrink-0 relative"
          id="app-header"
        >
          {activeTab === 'management' && selectedProject && headerContent ? (
            <div className="flex items-center justify-between w-full gap-2">
              <div className="flex items-center space-x-3 min-w-0 flex-1">
                {headerContent.backButton}
                {headerContent.title}
              </div>
              <div className="flex items-center space-x-2 shrink-0">
                {headerContent.actions}
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center space-x-3">
                {/* Sidebar toggle for PC */}
                <button
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                  className="p-2 text-slate-400 hover:bg-slate-100 rounded-xl transition-all hidden lg:block"
                  title="Toggle sidebar"
                >
                  <Menu size={20} />
                </button>

                {/* Mobile Brand */}
                <div
                  onClick={() => handleTabClick('management')}
                  className="flex lg:hidden items-center space-x-2 cursor-pointer p-4"
                >
                  <img
                    src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782285783/logo_app_va9ksb.png"
                    alt="Logo"
                    className="w-10 h-10 object-contain"
                    referrerPolicy="no-referrer"
                  />
                  <h1 className="text-lg font-black text-slate-100 tracking-tighter uppercase leading-none">DRACO-X2</h1>
                </div>

                <div className="hidden lg:flex items-center px-2">
                  <span className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">
                    {menuItems.find(item => item.id === activeTab)?.labelKey || 'Bảng Điều Khiển'}
                    {isSyncingData && (
                      <span className="text-[10px] text-indigo-600 font-black uppercase tracking-widest animate-pulse flex items-center gap-1 bg-indigo-100 px-2 py-0.5 rounded-lg">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 animate-ping inline-block" />
                        Đang đồng bộ...
                      </span>
                    )}
                  </span>
                </div>
              </div>
              {/* Mobile Profile */}
              <div
                onClick={() => setShowProfileModal(true)}
                className="flex md:hidden items-center hover:bg-slate-200 transition-colors py-1.5 px-2.5 rounded-xl cursor-pointer"
              >
                <div className="relative shrink-0">
                  {user?.photoURL ? (
                    <img src={user.photoURL} alt="User" className="w-10 h-10 rounded-full border border-slate-700" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 border border-slate-700">
                      <User size={16} />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3 shrink-0">
                {/* 🔔 Dropdown Thông báo */}
                <div className="relative" id="notification-dropdown-container">
                  <button
                    onClick={() => {
                      setNotifyDropdownOpen(!notifyDropdownOpen);
                    }}
                    className="p-2 bg-slate-100 hover:bg-rose-100 hover:text-rose-600 rounded-lg text-slate-600 relative transition-transform active:scale-95 cursor-pointer flex items-center justify-center"
                    title="Thông báo hệ thống"
                  >
                    <Bell size={18} />
                    {unreadNotificationCount > 0 && (
                      <span className="absolute -top-1 -right-1 bg-rose-500 text-white text-[9px] font-black w-4.5 h-4.5 rounded-full flex items-center justify-center border border-white animate-pulse">
                        {unreadNotificationCount}
                      </span>
                    )}
                  </button>

                  <AnimatePresence>
                    {notifyDropdownOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: 10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                        className="absolute right-0 mt-2.5 w-80 bg-white border border-slate-200 rounded-lg shadow-2xl z-100 overflow-hidden"
                      >
                        <div className="p-3 bg-slate-900 text-white flex items-center justify-between border-b border-rose-100/10">
                          <span className="text-xs font-black uppercase tracking-wider text-rose-400">Thông báo của tôi ({myNotifications.length})</span>
                          {unreadNotifications.length > 0 && (
                            <button
                              onClick={async () => {
                                if (!user) return;
                                const batch = writeBatch(db);
                                unreadNotifications.forEach((n) => {
                                  if (!n.id) return;
                                  const readBy = n.readBy || [];
                                  if (!readBy.includes(user.uid)) {
                                    batch.update(doc(db, 'notifications', n.id), {
                                      readBy: [...readBy, user.uid]
                                    });
                                  }
                                });
                                await batch.commit();
                              }}
                              className="text-[9px] bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700 font-black px-2 py-1 rounded-lg uppercase tracking-wide transition-all cursor-pointer"
                            >
                              {t("Đọc tất cả")}
                            </button>
                          )}
                        </div>

                        <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 p-1">
                          {myNotifications.length === 0 ? (
                            <div className="p-6 text-center text-slate-400 text-xs uppercase tracking-wide">
                              {t("Không có thông báo nào dành cho bạn")}
                            </div>
                          ) : (
                            myNotifications.slice(0, 8).map((n) => {
                              const isUnread = !n.readBy || !n.readBy.includes(user?.uid || '');
                              return (
                                <div
                                  key={n.id}
                                  onClick={async () => {
                                    if (!user || !n.id) return;
                                    const readBy = n.readBy || [];
                                    if (!readBy.includes(user.uid)) {
                                      await updateDoc(doc(db, 'notifications', n.id), {
                                        readBy: [...readBy, user.uid]
                                      });
                                    }

                                    if (n.linkTo) {
                                      if (n.linkTo.startsWith('delivery?orderId=')) {
                                        const ordId = n.linkTo.split('delivery?orderId=')[1];
                                        setSelectedOrderId(ordId);
                                        setActiveTab('delivery');
                                      } else if (n.linkTo === 'qc') {
                                        setActiveTab('qc');
                                      }
                                    }
                                    setNotifyDropdownOpen(false);
                                  }}
                                  className={`p-2.5 hover:bg-slate-100 transition-colors cursor-pointer rounded flex gap-2.5 items-start ${isUnread ? 'bg-rose-100/20' : ''}`}
                                >
                                  <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${isUnread ? 'bg-rose-500' : 'bg-slate-300'}`} />
                                  <div className="flex-1 min-w-0">
                                    <span className="text-xs font-bold text-slate-800 block truncate">{n.title}</span>
                                    <p className="text-xs text-slate-500 line-clamp-2 mt-0.5 leading-normal">{n.content}</p>
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* Language Switcher - Mobile */}
              <div className="relative group md:hidden">
                <button className="p-2.5 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer">
                  <Globe size={18} className="text-slate-500" />
                </button>
                <div className="absolute right-0 bottom-full mb-1 bg-white rounded-lg border border-slate-200 shadow-xl z-50 overflow-hidden opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all min-w-[120px]">
                  <button
                    onClick={() => setLang('en')}
                    className={`w-full px-3 py-2 text-[10px] font-black uppercase tracking-widest text-left transition-colors cursor-pointer flex items-center gap-2 ${lang === 'en' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-600 hover:bg-slate-50'}`}
                  >
                    🇬🇧 English
                  </button>
                  <button
                    onClick={() => setLang('vi')}
                    className={`w-full px-3 py-2 text-[10px] font-black uppercase tracking-widest text-left transition-colors cursor-pointer flex items-center gap-2 ${lang === 'vi' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-600 hover:bg-slate-50'}`}
                  >
                    🇻🇳 Tiếng Việt
                  </button>
                </div>
              </div>
            </>
          )}
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-10 scroll-smooth" id="app-content">
          <div className="min-h-full flex flex-col relative">
            <div
              key={activeTab + (selectedProject || '') + (resetKeys[activeTab] || 0)}
              className="flex-1"
            >
              {isSyncingData && projectEntries.length === 0 && (activeTab === 'management' || activeTab === 'qc' || activeTab === 'packing') ? (
                <div className="flex flex-col items-center justify-center py-24 text-slate-400 space-y-4 font-sans">
                  <div className="w-10 h-15 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-700 animate-pulse">Đang đồng bộ dữ liệu DRACO...</p>
                  <p className="text-[9px] text-slate-400 uppercase tracking-wider font-bold text-center">Bố cục ứng dụng đã sẵn sàng. Dữ liệu mộc & hoàn thiện đang được tải ngầm...</p>
                </div>
              ) : (
                <>
                  {activeTab === 'stats' && (
                    <StatsScreen
                      key={`stats-${resetKeys['stats'] || 0}`}
                      projectEntries={projectEntries}
                      qcTickets={qcTickets}
                      items={items}
                    />
                  )}
                  {activeTab === 'management' && (
                    <ManagementScreen
                      key={`management-${resetKeys['management'] || 0}-${selectedProject || ''}`}
                      items={items}
                      projectEntries={filteredProjectEntries}
                      setProjectEntries={setProjectEntries}
                      selectedProject={selectedProject}
                      setSelectedProject={setSelectedProject}
                      loading={loading}
                      isSelectMode={isSelectMode}
                      setIsSelectMode={setIsSelectMode}
                      selectedModuleIds={selectedModuleIds}
                      setSelectedModuleIds={setSelectedModuleIds}
                      showBulkModal={showBulkModal}
                      setShowBulkModal={setShowBulkModal}
                      setHeaderContent={setHeaderContent}
                      qcTickets={qcTickets}
                    />
                  )}
                  {activeTab === 'packing' && (
                    <PackingScreen
                      key={`packing-${resetKeys['packing'] || 0}-${selectedPackingId || ''}`}
                      projectEntries={projectEntries}
                      selectedPackingId={selectedPackingId}
                      setSelectedPackingId={setSelectedPackingId}
                      focusModuleName={focusModuleName}
                      focusInstanceIndex={focusInstanceIndex}
                      clearFocusModuleName={() => { setFocusModuleName(null); setFocusInstanceIndex(null); }}
                      isGuest={isGuest}
                      guestProjectCodes={guestProjectCodes}
                      onOpenCompletedProject={handleOpenCompletedProject}
                    />
                  )}
                  {activeTab === 'loading' && (
                    <LoadingScreen
                      key={`loading-${resetKeys['loading'] || 0}`}
                      projectEntries={activeProjectEntries}
                      isGuest={isGuest}
                      guestProjectCodes={guestProjectCodes}
                    />
                  )}
                  {activeTab === 'delivery' && (
                    <DeliveryReceiptScreen
                      key={`delivery-${resetKeys['delivery'] || 0}-${selectedOrderId || ''}`}
                      projectEntries={activeProjectEntries}
                      onComplete={() => { }}
                      initialOrderId={selectedOrderId}
                      onNavigatePacking={(moduleCode) => {
                        setSelectedPackingId(moduleCode);
                        setActiveTab('packing');
                      }}
                    />
                  )}
                  {activeTab === 'inventory' && (
                    <InventoryScreen
                      key={`inventory-${resetKeys['inventory'] || 0}`}
                      items={items}
                      projectEntries={activeProjectEntries}
                      loading={loading}
                    />
                  )}
                  {activeTab === 'users' && (
                    <UserManagementScreen
                      key={`users-${resetKeys['users'] || 0}`}
                      allUsers={allUsers}
                    />
                  )}
                  {activeTab === 'customers' && (
                    <CustomersScreen
                      key={`customers-${resetKeys['customers'] || 0}`}
                      projectEntries={projectEntries}
                    />
                  )}
                  {activeTab === 'scanner' && (
                    <QuickScannerScreen setPendingQCAction={setPendingQCAction} setParentActiveTab={setActiveTab}
                      key={`scanner-${resetKeys['scanner'] || 0}`}
                      projectEntries={projectEntries}
                      setProjectEntries={setProjectEntries}
                    />
                  )}
                  {activeTab === 'qc' && (
                    <QCInspectionScreen pendingQCAction={pendingQCAction} clearPendingQCAction={() => setPendingQCAction(null)}
                      key={`qc-${resetKeys['qc'] || 0}`}
                      projectEntries={activeProjectEntries}
                      setProjectEntries={setProjectEntries}
                    />
                  )}
                  {activeTab === 'test-code' && (
                    <TestCodeScreen
                      key={`test-code-${resetKeys['test-code'] || 0}`}
                    />
                  )}
                  {activeTab === ('printer-station' as any) && (
                    <PrinterStationScreen />
                  )}
                  {activeTab === 'tools' && (
                    <ToolsScreen
                      key={`tools-${resetKeys['tools'] || 0}`}
                    />
                  )}
                  {activeTab === 'extensions' && (
                    <ExtensionsScreen
                      key={`extensions-${resetKeys['extensions'] || 0}`}
                      projectEntries={activeProjectEntries}
                      allUsers={allUsers}
                      role={role}
                      onNavigateToTab={setActiveTab}
                    />
                  )}
                  {activeTab === 'planning' && (
                    <PlanningScreen
                      key={`planning-${resetKeys['planning'] || 0}`}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </main>

        {/* Bottom Menu Navigation Bar for Mobile */}
        <nav className="bg-white border-t border-slate-200 fixed bottom-0 left-0 right-0 z-100 flex lg:hidden min-h-[60px] pb-safe shadow-[0_-4px_20px_-10px_rgba(0,0,0,0.1)]" id="bottom-nav">
          <div className="mx-auto w-full max-w-lg flex items-center justify-around h-14 relative">

            {/* 5 FIXED SLOTS — QR centered, hidden buttons keep empty space */}
            {/* Slot 1: Dự Án */}
            <div className="flex-1 flex justify-center">
              <button
                onClick={() => {
                  handleTabClick('management');
                  setShowExtraMenu(false);
                }}
                className={`h-14 flex flex-col items-center justify-center space-y-0.5 transition-colors cursor-pointer ${activeTab === 'management' && !showExtraMenu ? 'text-indigo-600 font-extrabold' : 'text-slate-400'
                  }`}
              >
                <Layers size={18} />
                <span className="text-[9px] font-black uppercase tracking-tight">{t("Dự Án")}</span>
              </button>
            </div>

            {/* Slot 2: Kiểm Hàng (ẩn cho guest, giữ khoảng trống) */}
            <div className="flex-1 flex justify-center">
              {!isGuest ? (
              <button
                onClick={() => {
                  const item = menuItems.find(i => i.id === 'qc');
                  const allowed = item && (item.roles as readonly string[]).some(r => roles.includes(r));
                  if (allowed) {
                    handleTabClick('qc');
                    setShowExtraMenu(false);
                  } else {
                    alert('Tài khoản của bạn không được phân quyền Kiểm Hàng (Quản lý/QC)!');
                  }
                }}
                className={`h-14 flex flex-col items-center justify-center space-y-0.5 transition-colors relative cursor-pointer ${activeTab === 'qc' && !showExtraMenu ? 'text-indigo-600 font-extrabold' : 'text-slate-400'}`}
              >
                <div className="relative">
                  <ClipboardCheck size={18} />
                  {qcPendingCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 bg-rose-500 text-white text-[8px] font-black w-4 h-4 rounded-full flex items-center justify-center border border-white animate-pulse">
                      {qcPendingCount}
                    </span>
                  )}
                </div>
                <span className="text-[9px] font-black uppercase tracking-tight">{t("Kiểm Hàng")}</span>
              </button>
              ) : <div className="h-14" />}
            </div>

            {/* Slot 3: Quét QR (Floating — centered) */}
            <div className="flex-1 flex justify-center relative">
              <button
                onClick={() => {
                  handleTabClick('scanner');
                  setShowExtraMenu(false);
                }}
                className={`absolute -top-12 w-[54px] h-[54px] rounded-full flex flex-col items-center justify-center transition-all shadow-lg active:scale-90 cursor-pointer border-4 border-white z-100 ${activeTab === 'scanner' && !showExtraMenu
                    ? 'bg-indigo-600 text-white shadow-indigo-300 shadow-md ring-2 ring-indigo-600/20'
                    : 'bg-indigo-500 hover:bg-indigo-600 text-white shadow-slate-300'
                  }`}
                disabled={isBackgroundLoadingProjects}
              >
                {isBackgroundLoadingProjects ? (
                  <Loader2 size={30} className="animate-spin" />
                ) : (
                  <ScanQrCode size={30} className="animate-pulse" />
                )}
              </button>
            </div>

            {/* Slot 4: Đóng Gói */}
            <div className="flex-1 flex justify-center">
              <button
                onClick={() => {
                  handleTabClick('packing');
                  setShowExtraMenu(false);
                }}
                className={`h-14 flex flex-col items-center justify-center space-y-0.5 transition-colors relative cursor-pointer ${activeTab === 'packing' && !showExtraMenu ? 'text-indigo-600 font-extrabold' : 'text-slate-400'
                  }`}
              >
                <div className="relative">
                  <Package size={18} />
                  {packingPendingCount > 0 && (
                    <span className={`absolute -top-1.5 -right-1.5 text-[8px] font-black w-4 h-4 rounded-full flex items-center justify-center border border-white ${isGuest ? 'bg-slate-500 text-white' : 'bg-rose-500 text-white animate-pulse'}`}>
                      {packingPendingCount}
                    </span>
                  )}
                </div>
                <span className="text-[9px] font-black uppercase tracking-tight">{t("Đóng Gói")}</span>
              </button>
            </div>

            {/* Slot 5: Thêm (non-guest) / Cài đặt (guest) */}
            <div className="flex-1 flex justify-center">
              {!isGuest ? (
              <button
                onClick={() => setShowExtraMenu(!showExtraMenu)}
                className={`h-14 flex flex-col items-center justify-center space-y-0.5 transition-colors relative cursor-pointer ${showExtraMenu ? 'text-indigo-600 font-extrabold' : 'text-slate-400'
                  }`}
              >
                <div className="relative">
                  <Menu size={18} />
                  {(() => {
                    const extraMenuBadgeCount = guestFilteredMenuItems
                      .filter(item => !['management', 'qc', 'scanner', 'packing'].includes(item.id))
                      .reduce((sum, item) => sum + getBadgeCount(item.id), 0);
                    return extraMenuBadgeCount > 0 ? (
                      <span className="absolute -top-1.5 -right-1.5 bg-rose-500 text-white text-[8px] font-black w-4 h-4 rounded-full flex items-center justify-center border border-white animate-pulse">
                        {extraMenuBadgeCount}
                      </span>
                    ) : null;
                  })()}
                </div>
                <span className="text-[9px] font-black uppercase tracking-tight">{t("Thêm")}</span>
              </button>
              ) : (
              <button
                onClick={() => setShowGuestSettings(true)}
                className="h-14 flex flex-col items-center justify-center space-y-0.5 transition-colors relative cursor-pointer text-slate-400"
              >
                <Settings size={18} />
                <span className="text-[9px] font-black uppercase tracking-tight">{t('Cài đặt')}</span>
              </button>
              )}
            </div>

          </div>

          {/* Panel danh mục mở rộng bento Flat của showExtraMenu */}
          {showExtraMenu && (
            <>
              <div
                className="fixed inset-0 z-[45] bg-slate-900/40 backdrop-blur-xs transition-opacity"
                onClick={() => setShowExtraMenu(false)}
              />
              <div
                className="fixed bottom-[68px] left-4 right-4 bg-white rounded-lg border border-slate-200 shadow-2xl z-[50] overflow-hidden max-w-md mx-auto animate-in slide-in-from-bottom-4 duration-200"
              >
                <div className="bg-slate-900 px-4 py-3 flex items-center justify-between">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest font-sans">Danh mục mở rộng</span>
                  <button
                    onClick={() => setShowExtraMenu(false)}
                    className="text-slate-400 hover:text-white transition-colors cursor-pointer rounded-lg p-0.5"
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="p-4 grid grid-cols-3 gap-3 bg-slate-100">
                  {(() => {
                    const extraMenuItems = guestFilteredMenuItems.filter(item => {
                      return !['management', 'qc', 'scanner', 'packing'].includes(item.id);
                    });

                    if (extraMenuItems.length === 0) {
                      return (
                        <div className="col-span-3 text-center py-6 text-xs text-slate-400 uppercase font-black font-sans tracking-wide">
                          Không có chức năng mở rộng khả dụng
                        </div>
                      );
                    }

                    return extraMenuItems.map(item => {
                      const badgeCount = getBadgeCount(item.id);
                      return (
                        <button
                          key={item.id}
                          onClick={() => {
                            handleTabClick(item.id as Tab);
                            setShowExtraMenu(false);
                          }}
                          className={`flex flex-col items-center justify-center p-3 rounded-lg bg-white border cursor-pointer transition-all active:scale-95 ${activeTab === item.id
                              ? 'border-indigo-600 ring-1 ring-indigo-600/10 shadow-xs'
                              : 'border-slate-200 hover:bg-slate-100'
                            }`}
                        >
                          <div className="relative mb-1.5 font-sans">
                            <div className={`p-2.5 rounded-lg ${item.color || 'bg-slate-500'} text-white`}>
                              {item.icon}
                            </div>
                            {badgeCount > 0 && (
                              <span className={`absolute -top-1.5 -right-1.5 text-[8px] font-black w-4.5 h-4.5 rounded-full flex items-center justify-center border border-white ${isGuest ? 'bg-slate-500 text-white' : 'bg-rose-500 text-white animate-pulse'}`}>
                                {badgeCount}
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] font-black text-slate-700 uppercase tracking-tight text-center leading-tight font-sans">
                            {t(item.labelKey)}
                          </span>
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>
            </>
          )}
        </nav>

        {showProfileModal && (
          <UserProfileModal
            profile={userProfile || { uid: user?.uid || '', displayName: '', email: '' } as any}
            isGuest={isGuest}
            onClose={() => setShowProfileModal(false)}
          />
        )}
        {isGuest && (
          <GuestSettingsModal
            isOpen={showGuestSettings}
            onClose={() => setShowGuestSettings(false)}
          />
        )}

        {/* Nút nổi di động để chuyển nhanh giữa Thống Kê và Kế Hoạch */}
        {(activeTab === 'stats' || activeTab === 'planning') && (
          <div className="fixed bottom-20 right-4 z-[110] lg:hidden" id="mobile-toggle-fab-container">
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => {
                if (activeTab === 'stats') {
                  handleTabClick('planning');
                } else {
                  handleTabClick('stats');
                }
              }}
              className={`w-12 h-12 rounded-xl flex items-center justify-center text-white shadow-lg transition-all border border-transparent cursor-pointer ${activeTab === 'stats'
                  ? 'bg-emerald-600 shadow-emerald-600/20 active:bg-emerald-700'
                  : 'bg-indigo-600 shadow-indigo-600/20 active:bg-indigo-700'
                }`}
              title={activeTab === 'stats' ? "Chuyển sang Kế Hoạch" : "Chuyển sang Thống Kê"}
            >
              {activeTab === 'stats' ? <ListTodo size={20} /> : <BarChart3 size={20} />}
            </motion.button>
          </div>
        )}
      </div>
    </div>
  );
}

function AppContent() {
  const { user, login, loading, logout, role, roles, isGuest, guestProjectCodes } = useAuth();
  const { setLang } = useLanguage();
  const [publicOrderId, setPublicOrderId] = useState<string | null>(null);
  const [isToolsPage, setIsToolsPage] = useState(false);
  const [isQuickScanPage, setIsQuickScanPage] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const path = window.location.pathname;
    if (path === '/tools' || params.get('page') === 'tools') {
      setIsToolsPage(true);
    }
    if (path === '/nhapnhanh' || params.get('page') === 'nhapnhanh') {
      setIsQuickScanPage(true);
    }
    const orderId = params.get('orderId');
    if (orderId) {
      setPublicOrderId(orderId);
    }
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center space-y-4" id="loading-screen">
        <motion.div
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut" }}
          className="w-20 h-20 flex items-center justify-center"
          id="loading-logo"
        >
          <img
            src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782285783/logo_app_va9ksb.png"
            alt="DRACO-X2 Logo"
            className="w-20 h-20 object-contain"
            referrerPolicy="no-referrer"
          />
        </motion.div>
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 animate-pulse">DRACO SYSTEM LOADING</p>
      </div>
    );
  }

  // Các trang đặc biệt không cần customer code
  const isSpecialPage = isToolsPage || isQuickScanPage || publicOrderId;

  if (isToolsPage) {
    return (
      <div className="min-h-screen bg-slate-100 transition-colors duration-300">
        <ToolsScreen />
      </div>
    );
  }

  if (isQuickScanPage) {
    if (!user) {
      return (
        <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-full max-w-sm bg-white border border-slate-200 rounded-lg shadow-sm p-8 space-y-6">
            <div className="flex flex-col items-center space-y-3">
              <div className="bg-indigo-100 text-indigo-600 border border-indigo-100 p-3 rounded-lg flex items-center justify-center">
                <ScanQrCode size={28} />
              </div>
              <div className="text-center">
                <h1 className="text-lg font-black text-slate-800 uppercase tracking-tight font-sans">Quét Mã Đối Chiếu</h1>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">Đăng nhập để sử dụng tính năng Lưu & Đối Chiếu</p>
              </div>
            </div>
            <div className="h-px bg-slate-100"></div>
            <p className="text-xs text-slate-500 leading-relaxed">
              Hệ thống quản lý chất lượng DRACO. Vui lòng sử dụng tài khoản Google của bạn để truy cập tính năng Quét QR Nhập Nhanh & Đối Chiếu Cấu Kiện.
            </p>
            <button
              onClick={login}
              type="button"
              className="w-full bg-indigo-600 hover:bg-slate-900 text-white font-black py-4 px-4 rounded-lg flex items-center justify-center space-x-3 transition-colors active:scale-[0.98] uppercase text-[11px] tracking-widest cursor-pointer"
            >
              <LogOut size={16} className="rotate-180" />
              <span>Đăng nhập với Google</span>
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-slate-100 transition-colors duration-300">
        <QuickScannerScreen
          onBack={() => {
            setIsQuickScanPage(false);
            window.history.replaceState({}, '', '/');
          }}
        />
      </div>
    );
  }

  if (!user && publicOrderId) {
    return (
      <div className="min-h-screen bg-slate-100 p-4 lg:p-10 transition-colors duration-300">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center space-x-3 mb-10 transition-all select-none">
            <img
              src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782285783/logo_app_va9ksb.png"
              alt="Logo"
              className="w-10 h-10 object-contain"
              referrerPolicy="no-referrer"
            />
            <span className="font-black text-xl tracking-tight text-slate-900 uppercase">DRACO-X2</span>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-none">
            <DeliveryListScreen initialOrderId={publicOrderId} hideHeader={true} />
          </div>
          <div className="mt-10 text-center">
            <button
              onClick={() => {
                setPublicOrderId(null);
                window.history.replaceState({}, '', window.location.pathname);
              }}
              className="text-[10px] font-black text-slate-400 hover:text-indigo-600 transition-colors uppercase tracking-widest"
            >
              Quay lại trang đăng nhập
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Check for admin/pending - kiểm tra cả role (string) và roles (array)
  const hasApprovedRole = (role && role !== 'pending') || (roles && roles.some(r => r !== 'pending'));
  if (user && !hasApprovedRole) {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-6 text-center space-y-8">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 25, ease: "linear" }}
          className="w-24 h-24 bg-white rounded-3xl shadow-none flex items-center justify-center text-indigo-600 border border-slate-200"
        >
          <Clock size={48} />
        </motion.div>
        <div className="space-y-4 max-w-sm w-full">
          <h2 className="text-2xl font-black text-slate-900 uppercase tracking-tight">Đang Chờ Phê Duyệt</h2>
          <div className="p-6 bg-white rounded-3xl border border-slate-200 space-y-6">
            <div>
              <p className="text-sm text-slate-900 font-black uppercase tracking-tight mb-1">
                {user.displayName}
              </p>
              <p className="text-[11px] text-slate-400 font-bold uppercase tracking-widest">
                {user.email}
              </p>
            </div>
            <div className="h-px bg-slate-100"></div>
            <p className="text-[11px] text-orange-500 font-black uppercase leading-relaxed tracking-wide">
              Tài khoản bạn chưa được kích hoạt.<br />Vui lòng liên hệ Admin.
            </p>
          </div>
        </div>
        <button
          onClick={logout}
          className="flex items-center space-x-2 text-slate-400 hover:text-red-500 transition-colors font-black uppercase text-[10px] tracking-widest bg-white px-6 py-3 rounded-full border border-slate-100 shadow-none"
        >
          <LogOut size={16} />
          <span>Đăng xuất tài khoản</span>
        </button>
      </div>
    );
  }

  return user ? <MainScreen /> : <LoginScreen />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
      <PwaInstallPrompt />
    </AuthProvider>
  );
}
