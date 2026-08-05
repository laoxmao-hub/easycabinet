/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Truck, CheckCircle, Calendar, User, Package, ChevronRight, X, FileText, Hash, Share2, Link as LinkIcon, Printer, RotateCcw, Plus, Trash2, Pencil, Loader2 as LoaderIcon,
  Clock, ScanQrCode, AlertTriangle, RefreshCw, Search, Filter, Check
} from 'lucide-react';
import {
  collection, query, onSnapshot, doc, getDoc, where, updateDoc
} from 'firebase/firestore';
import { toPng } from 'html-to-image';
import { useAuth } from '../lib/AuthContext';
import { db, handleFirestoreError, OperationType, cleanUndefinedFields } from '../lib/firebase';
import { ShippingOrder, ShippingOrderItem, ProjectEntry, getModuleInstances } from '../types';
import { ScannerModal, ScannedResult } from '../components/ScannerModal';
import { formatProjectCode, formatProjectName } from '../lib/formatters';
import {
  writeBatch, serverTimestamp, getDocs
} from 'firebase/firestore';
import { getEntryType, getParentCodeCandidate } from './ProjectManagementScreen';
import { updateProjectModule, batchUpdateProjectModules, findProjectConfigId, findModuleConfigId } from '../lib/dualWrite';

const fallbackDateCache = new Map<string, Date>();

function getStableDateForId(id: string): Date {
  let cached = fallbackDateCache.get(id);
  if (!cached) {
    // Tạo ngày cố định từ hash của ID để không phụ thuộc thời gian load trang
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    const dayOffset = Math.abs(hash) % 365;
    const baseDate = new Date(2024, 0, 1);
    baseDate.setDate(baseDate.getDate() + dayOffset);
    cached = baseDate;
    fallbackDateCache.set(id, cached);
  }
  return cached;
}

export function parseFirestoreDate(val: any, fallbackId?: string): Date {
  if (!val) {
    return getStableDateForId(fallbackId || 'unknown');
  }
  // Handle serverTimestamp() sentinel object { _methodName: "serverTimestamp" }
  if (typeof val === 'object' && val._methodName === 'serverTimestamp') {
    return getStableDateForId(fallbackId || 'unknown');
  }
  try {
    if (typeof val.toDate === 'function') {
      return val.toDate();
    }
    if (val instanceof Date) {
      return val;
    }
    if (typeof val.seconds === 'number') {
      return new Date(val.seconds * 1000);
    }
    if (val.seconds && typeof val.seconds === 'number') {
      return new Date(val.seconds * 1000);
    }
    // Nếu rớt vào trường hợp là một object rỗng {} do bị bẻ gãy cấu trúc trước đó
    if (typeof val === 'object' && Object.keys(val).length === 0) {
      if (fallbackId) {
        return getStableDateForId(fallbackId);
      }
      return new Date();
    }
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d;
    }
  } catch (e) {
    console.warn("Lỗi parse ngày:", val, e);
  }
  if (fallbackId) {
    return getStableDateForId(fallbackId);
  }
  return new Date();
}

export function DeliveryListScreen({ hideHeader = false, initialOrderId, onSelectOrder }: { hideHeader?: boolean, initialOrderId?: string | null, onSelectOrder?: (orderId: string) => void }) {
  const { user } = useAuth();
  const [orders, setOrders] = useState<ShippingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'receive' | 'ship'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'completed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedOrder, setSelectedOrder] = useState<ShippingOrder | null>(null);
  const [logoBase64, setLogoBase64] = useState<string | null>(null);

  // State phục vụ việc kiểm hàng nhận ngay trên phiếu giao
  const [activeCheckingOrder, setActiveCheckingOrder] = useState<ShippingOrder | null>(null);
  const [showCheckingScanner, setShowCheckingScanner] = useState(false);
  const [projectEntriesForScanner, setProjectEntriesForScanner] = useState<ProjectEntry[]>([]);

  // State phục vụ nhập số lượng khi quét module kiểu "bo"
  const [pendingBoScan, setPendingBoScan] = useState<{
    result: ScannedResult;
    matchedItemIndex: number;
    maxAllowed: number;
    matchedItem: any;
  } | null>(null);
  const [boScanQtyInput, setBoScanQtyInput] = useState<number | ''>(1);

  useEffect(() => {
    if (!user) return;
    const unsubscribe = onSnapshot(query(collection(db, 'projectConfigs')), async (configSnap) => {
      const allEntries: ProjectEntry[] = [];
      for (const configDoc of configSnap.docs) {
        const modulesSnap = await getDocs(collection(db, 'projectConfigs', configDoc.id, 'modules'));
        modulesSnap.docs.forEach(d => {
          allEntries.push({ id: d.id, ...d.data(), configId: configDoc.id } as ProjectEntry);
        });
      }
      setProjectEntriesForScanner(allEntries);
    });
    return () => unsubscribe();
  }, [user]);

  const executeBoScanChecking = async (qty: number) => {
    if (!pendingBoScan || !activeCheckingOrder) return;

    const { matchedItemIndex, matchedItem, result } = pendingBoScan;
    const currentChecked = matchedItem.checkedQty || 0;
    const nextChecked = currentChecked + qty;

    let nextScannedInstanceIds = [...(matchedItem.scannedInstanceIds || [])];
    if (result.instanceId && !nextScannedInstanceIds.includes(result.instanceId)) {
      nextScannedInstanceIds.push(result.instanceId);
    }

    const updatedItems = activeCheckingOrder.items.map((item, idx) => {
      if (idx === matchedItemIndex) {
        return {
          ...item,
          checkedQty: nextChecked,
          scannedInstanceIds: nextScannedInstanceIds
        };
      }
      return item;
    });

    const isAllCompleted = updatedItems.every(item => (item.checkedQty || 0) >= item.quantity);
    const nextStatus = isAllCompleted ? 'completed' : 'pending';

    try {
      // 1. Cập nhật phiếu giao (shipping_orders)
      await updateDoc(doc(db, 'shipping_orders', activeCheckingOrder.id), {
        items: updatedItems,
        status: nextStatus
      });

      // Cập nhật state cục bộ để đồng bộ ngay lập tức
      setActiveCheckingOrder(prev => {
        if (!prev) return null;
        return {
          ...prev,
          items: updatedItems,
          status: nextStatus
        };
      });

      // 2. Cập nhật receivedQuantity của module này trong Firestore projects
      if (matchedItem.id) {
        const configId = await findProjectConfigId(matchedItem.projectCode || activeCheckingOrder.projectCode || '');
        if (configId) {
          const entryRef = doc(db, 'projectConfigs', configId, 'modules', matchedItem.id);
          const entrySnap = await getDoc(entryRef);
          if (entrySnap.exists()) {
            const entryData = entrySnap.data() as ProjectEntry;
            const currentInstances = getModuleInstances(entryData);

            let updatedInstances = [...currentInstances];
            let nextReceived = entryData.receivedQuantity || 0;
            const displayLabel = user?.displayName || user?.email || 'Unknown';

            const newDeliveryLog = {
              type: 'receive' as const,
              date: new Date(),
              by: displayLabel,
              notes: `Kiểm nhận từ phiếu giao ${activeCheckingOrder.title || ''} (Số lượng: ${qty})`
            };

            if (result.instanceId) {
              updatedInstances = currentInstances.map(inst => {
                if (inst.instanceId === result.instanceId || inst.id === result.instanceId) {
                  if (!inst.delivered) {
                    nextReceived += 1;
                  }
                  const logs = inst.deliveryLogs || [];
                  return {
                    ...inst,
                    delivered: true,
                    deliveryLogs: [...logs, newDeliveryLog]
                  };
                }
                return inst;
              });
            } else {
              let autoDeliverCount = qty;
              updatedInstances = currentInstances.map(inst => {
                if (autoDeliverCount > 0 && !inst.delivered) {
                  nextReceived += 1;
                  autoDeliverCount--;
                  const logs = inst.deliveryLogs || [];
                  return {
                    ...inst,
                    delivered: true,
                    deliveryLogs: [...logs, newDeliveryLog]
                  };
                }
                return inst;
              });
              if (autoDeliverCount > 0) {
                nextReceived += autoDeliverCount;
              }
            }

            const isFullyReceived = nextReceived >= entryData.quantity;
            const newStatus = isFullyReceived ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận';

            const history = [...(entryData.statusHistory || [])];
            if (!history.length || history[history.length - 1].split('|')[0] !== newStatus) {
              history.push(`${newStatus}|${Date.now()}`);
            }

            await updateProjectModule(matchedItem.id, {
              instances: updatedInstances,
              receivedQuantity: nextReceived,
              status: newStatus,
              statusHistory: history
            }, matchedItem.projectCode || activeCheckingOrder.projectCode);
          }
        }
      }

      alert(`THÀNH CÔNG: Đã nhận thêm ${qty} cái [ ${matchedItem.moduleCode} ]. Tổng đã nhận: ${nextChecked}`);
      setPendingBoScan(null);
      if (isAllCompleted) {
        alert(`HOÀN TẤT: Toàn bộ hàng trong phiếu giao đã được kiểm nhận ĐẦY ĐỦ! Phiếu đã đổi sang màu XANH LÁ.`);
        setActiveCheckingOrder(null);
      }
    } catch (err: any) {
      console.error("Lỗi cập nhật kiểm hàng:", err);
      alert(`Lỗi hệ thống: ${err.message || String(err)}`);
    }
  };

  const handleCheckingScanConfirm = async (result: ScannedResult) => {
    if (!activeCheckingOrder) return;

    let rawText = result.rawCode || result.moduleCode || '';

    // Bước 0: Loại bỏ prefix số định danh (ví dụ: "20.ELMB1_..." -> "ELMB1_...")
    const cleanText = rawText.replace(/^\d+\./, '').trim();

    // Bước 1: Tìm khớp trực tiếp theo id hoặc moduleCode
    let matchedEntry = projectEntriesForScanner.find(e =>
      e.id === result.matchedId ||
      (e.moduleCode || '').toLowerCase() === cleanText.toLowerCase() ||
      (e.moduleCode || '').toLowerCase() === (result.moduleCode || '').toLowerCase()
    ) || null;

    // Bước 2: Quy đổi Đầu_Cuối (ví dụ: "ELMB1_Cánh phải_KIT.T2" -> "ELMB1_KIT.T2")
    if (!matchedEntry) {
      const parts = cleanText.split('_');
      if (parts.length >= 2) {
        const step2Code = `${parts[0]}_${parts[parts.length - 1]}`;
        matchedEntry = projectEntriesForScanner.find(e =>
          (e.moduleCode || '').toLowerCase() === step2Code.toLowerCase()
        ) || null;
      }
    }

    // Tạo item mới - mặc định thêm vào không check gì
    const newItem = {
      id: matchedEntry?.id || '',
      moduleCode: matchedEntry?.moduleCode || rawText,
      name: matchedEntry?.moduleCode || rawText,
      quantity: 1,
      checkedQty: 1,
      width: matchedEntry?.width || 0,
      depth: matchedEntry?.depth || 0,
      height: matchedEntry?.height || 0,
      cluster: matchedEntry?.cluster || '',
      projectCode: matchedEntry?.projectCode || activeCheckingOrder.projectCode,
      projectName: matchedEntry?.projectName || '',
      scannedInstanceIds: result.instanceId ? [result.instanceId] : []
    };

    const updatedItems = [newItem, ...activeCheckingOrder.items];

    try {
      await updateDoc(doc(db, 'shipping_orders', activeCheckingOrder.id), {
        items: updatedItems
      });
      setActiveCheckingOrder(prev => prev ? { ...prev, items: updatedItems } : null);
      setShowCheckingScanner(false);
    } catch (err) {
      console.error("Lỗi cập nhật kiểm nhận:", err);
      alert("Đã xảy ra lỗi khi cập nhật. Vui lòng thử lại.");
    }
  };

  // Pre-load logo as base64 to avoid CORS issues during print
  useEffect(() => {
    // New direct link for Cloudinary image
    const logoUrl = "https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782286423/logochan_m2cj0i.jpg";
    fetch(logoUrl)
      .then(res => res.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => setLogoBase64(reader.result as string);
        reader.readAsDataURL(blob);
      })
      .catch(err => console.error("Logo load error:", err));
  }, []);

  useEffect(() => {
    // If not logged in and have initialOrderId, just fetch that one
    if (!user && initialOrderId) {
      console.log("Fetching order for public view, ID:", initialOrderId);
      const fetchSingleOrder = async () => {
        try {
          const docRef = doc(db, 'shipping_orders', initialOrderId);
          console.log("Requesting getDoc for path:", docRef.path);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            console.log("Order found!");
            const order = { id: docSnap.id, ...docSnap.data() } as ShippingOrder;
            setOrders([order]);
            setSelectedOrder(order);
            setError(null);
          } else {
            console.warn("Order not found in Firestore.");
            setError("Không tìm thấy thông tin phiếu này.");
          }
          setLoading(false);
        } catch (err: any) {
          console.error("Error fetching public order:", err);
          setError(`Lỗi truy cập: ${err.message || "Kiểm tra quyền hạn hoặc kết nối"}`);
          setLoading(false);
        }
      };
      fetchSingleOrder();
      return;
    }

    // If no user and no initial ID, stop loading
    if (!user && !initialOrderId) {
      setLoading(false);
      return;
    }

    const q = query(
      collection(db, 'shipping_orders')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ShippingOrder));
      setOrders(fetchedOrders);
      setLoading(false);
    }, (error) => {
      // If we have an initialOrderId, we might have seen it via getDoc already
      // but let's handle the error gracefully for the list listener
      if (user) {
        handleFirestoreError(error, OperationType.GET, 'shipping_orders');
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user, initialOrderId]);

  useEffect(() => {
    if (initialOrderId && !loading && orders.length > 0 && onSelectOrder) {
      onSelectOrder(initialOrderId);
    }
  }, [initialOrderId, loading, orders, onSelectOrder]);

  const filteredOrders = orders
    .filter(order => {
      if (filter === 'receive') return order.type === 'receive';
      if (filter === 'ship') return order.type === 'ship';
      return true;
    })
    .filter(order => {
      if (statusFilter === 'pending') {
        return order.status !== 'completed';
      }
      if (statusFilter === 'completed') {
        return order.status === 'completed' || order.type === 'receive';
      }
      return true;
    })
    .filter(order => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();
      const codeMatches = (order.projectCode || '').toLowerCase().includes(q);
      const nameMatches = (order.projectName || '').toLowerCase().includes(q);
      const userMatches = (order.userName || '').toLowerCase().includes(q);
      const numMatches = `#${order.sequenceNumber}`.includes(q) || String(order.sequenceNumber).includes(q);
      const itemMatches = order.items && order.items.some(item =>
        (item.moduleCode || '').toLowerCase().includes(q)
      );
      return codeMatches || nameMatches || userMatches || numMatches || itemMatches;
    })
    .sort((a, b) => {
      const hasA = !!a.createdAt && !(typeof a.createdAt === 'object' && a.createdAt?._methodName === 'serverTimestamp');
      const hasB = !!b.createdAt && !(typeof b.createdAt === 'object' && b.createdAt?._methodName === 'serverTimestamp');
      if (!hasA && !hasB) return 0;
      if (!hasA) return 1;
      if (!hasB) return -1;
      const timeA = parseFirestoreDate(a.createdAt, a.id).getTime();
      const timeB = parseFirestoreDate(b.createdAt, b.id).getTime();
      return timeB - timeA;
    });

  return (
    <div className={`${hideHeader ? '' : 'pb-24'}`}>
      {!hideHeader && (
        <div className="flex items-center justify-between mb-4 border-b border-gray-200 pb-2">
          <h2 className="text-xl font-medium text-gray-800">Lịch Sử Giao Nhận</h2>
        </div>
      )}
      <div className="px-6 py-4 bg-gray-100 border-b border-gray-100 flex items-center space-x-3">
        <div className="p-2 bg-primary/10 text-primary rounded-md">
          <Clock size={20} />
        </div>
        <h3 className="text-sm font-black text-gray-800 uppercase tracking-widest">Lịch sử phiếu Giao Nhận</h3>
      </div>

      {/* Bộ lọc Phiếu giao nhận */}
      <div className="p-4 bg-white border-b border-gray-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Tìm kiếm */}
        <div className="relative flex-1 max-w-sm">
          <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
            <Search size={14} />
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
            placeholder="Tìm theo Mã dự án, Tên, Số phiếu, Cấu kiện..."
            className="w-full pl-9 pr-4 py-1.5 text-xs border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-bold placeholder:text-slate-400"
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setCurrentPage(1); }}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-600"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Bộ lọc Loại & Trạng thái */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Lọc loại phiếu */}
          <div className="flex bg-slate-100 p-1 rounded-lg">
            <button
              onClick={() => { setFilter('all'); setCurrentPage(1); }}
              className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${filter === 'all' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              Tất cả loại
            </button>
            <button
              onClick={() => { setFilter('receive'); setCurrentPage(1); }}
              className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${filter === 'receive' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              Nhận hàng
            </button>
            <button
              onClick={() => { setFilter('ship'); setCurrentPage(1); }}
              className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${filter === 'ship' ? 'bg-amber-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              Giao hàng
            </button>
          </div>

          {/* Lọc trạng thái */}
          <div className="flex bg-slate-100 p-1 rounded-lg">
            <button
              onClick={() => { setStatusFilter('all'); setCurrentPage(1); }}
              className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${statusFilter === 'all' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              Tất cả t.thái
            </button>
            <button
              onClick={() => { setStatusFilter('pending'); setCurrentPage(1); }}
              className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${statusFilter === 'pending' ? 'bg-amber-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              title="Chờ kiểm hàng (Chỉ dùng cho phiếu Giao)"
            >
              Chờ kiểm
            </button>
            <button
              onClick={() => { setStatusFilter('completed'); setCurrentPage(1); }}
              className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${statusFilter === 'completed' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              title="Đã kiểm đủ (Chỉ dùng cho phiếu Giao)"
            >
              Đã kiểm đủ
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400 space-y-4">
          <Loader2 className="animate-spin" size={32} />
          <p className="text-sm italic">Đang tải dữ liệu...</p>
        </div>
      ) : error ? (
        <div className="bg-white p-12 rounded-lg shadow-sm border border-red-100 flex flex-col items-center justify-center text-red-500 space-y-4 text-center">
          <div className="p-4 bg-red-100 rounded-full">
            <X size={48} />
          </div>
          <p className="text-sm font-bold uppercase tracking-widest">{error}</p>
          <p className="text-xs text-gray-400 max-w-xs">Nếu bạn chắc chắn link này đúng, vui lòng thử tải lại trang hoặc liên hệ quản trị viên.</p>
        </div>
      ) : filteredOrders.length > 0 ? (() => {
        const totalPages = Math.ceil(filteredOrders.length / 10);
        const startIdx = (currentPage - 1) * 10;
        const paginatedOrders = filteredOrders.slice(startIdx, startIdx + 10);
        return (
          <>
            <div className="space-y-2">
              {paginatedOrders.map((order) => {
                const isShip = order.type === 'ship';
                const isCompleted = order.status === 'completed';

                // Thiết lập classes theo yêu cầu: phiếu giao sau khi tạo màu cam, hoàn tất màu xanh lá
                let itemBgClass = "bg-white hover:bg-slate-100 border-l-4 border-l-indigo-500 border-t border-b border-gray-100";
                let iconBgClass = "bg-indigo-100 text-indigo-600";
                let txtColorClass = "text-gray-800";
                let labelBadge = null;

                if (isShip) {
                  if (isCompleted) {
                    itemBgClass = "bg-white hover:bg-slate-50 border border-gray-200 border-l-4 border-l-blue-500";
                    iconBgClass = "bg-blue-100 text-blue-700";
                    txtColorClass = "text-blue-900";
                    labelBadge = (
                      <span className="text-[9px] font-black uppercase tracking-wider bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded-sm">
                        Đã nhận đủ
                      </span>
                    );
                  } else {
                    itemBgClass = "bg-white hover:bg-slate-50 border border-gray-200 border-l-4 border-l-amber-500";
                    iconBgClass = "bg-amber-100 text-amber-700";
                    txtColorClass = "text-amber-900";
                    labelBadge = (
                      <span className="text-[9px] font-black uppercase tracking-wider bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-sm">
                        Chờ kiểm hàng
                      </span>
                    );
                  }
                } else {
                  itemBgClass = "bg-white hover:bg-slate-50 border border-gray-200 border-l-4 border-l-emerald-500";
                  iconBgClass = "bg-emerald-100 text-emerald-700";
                  txtColorClass = "text-emerald-900";
                  labelBadge = (
                    <span className="text-[9px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded-sm">
                      Phiếu nhận
                    </span>
                  );
                }

                return (
                  <div
                    key={order.id}
                    onClick={() => onSelectOrder ? onSelectOrder(order.id) : setSelectedOrder(order)}
                    className={`p-4 flex items-start justify-between group transition-all cursor-pointer rounded-lg ${itemBgClass}`}
                  >
                    <div className="flex items-start space-x-4 w-full">
                      <div className={`p-2 rounded-sm ${iconBgClass}`}>
                        {order.type === 'receive' ? <CheckCircle size={20} /> : <Truck size={20} />}
                      </div>
                      <div className="flex-1 flex flex-col space-y-1">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            
                            <span className="text-[10px] text-gray-400 flex items-center">
                              <Calendar size={10} className="mr-1" />
                              {parseFirestoreDate(order.createdAt, order.id).toLocaleString('vi-VN')}
                            </span>
                          </div>
                          {labelBadge}
                        </div>
                        <p className={` font-black ${txtColorClass}`}>
                          Dự án: {(() => {
                            const uniqueProjects = Array.from(new Set((order.items || []).map(i => i.projectCode).filter(Boolean)));
                            const names = uniqueProjects.map(code => {
                              const entry = order.items?.find(i => i.projectCode === code);
                              return entry?.projectName || formatProjectCode(code);
                            });
                            return names.join(', ');
                          })()}
                        </p>
                        <p className="text-xs text-gray-500 italic leading-relaxed">
                          Chứa tổng cộng <b>{order.items.reduce((sum, item) => sum + (item.quantity || 0), 0)}</b> cấu kiện cần giao
                        </p>

                        {/* Tiến độ kiểm nếu là phiếu giao CHƯA hoàn tất */}
                        {isShip && !isCompleted && (
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-600 bg-black/5 p-1 px-2 rounded-sm w-fit font-bold">
                            {order.items.map((item, idx) => {
                              const done = item.checkedQty || 0;
                              const req = item.quantity;
                              const isItemOk = done >= req;
                              return (
                                <span key={idx} className={isItemOk ? "text-emerald-700" : "text-amber-700"}>
                                  {item.moduleCode}: {done}/{req}
                                </span>
                              );
                            })}
                          </div>
                        )}

                        <div className="flex items-center space-x-3 pt-1">
                          <div className="flex items-center text-gray-400 text-[10px] uppercase font-bold">
                            <User size={10} className="mr-1" />
                            {order.userName}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center space-x-3 self-center shrink-0">
                      <ChevronRight size={20} className="text-gray-300 group-hover:text-primary transition-colors" />
                    </div>
                  </div>
                );
              })}
            </div>

            {filteredOrders.length > 10 && (() => {
              const tp = Math.ceil(filteredOrders.length / 10);
              const si = (currentPage - 1) * 10;
              return (
                <div className="flex items-center justify-between mt-4 px-2">
                  <p className="text-[11px] font-bold text-slate-400">
                    Hiển thị {si + 1}-{Math.min(si + 10, filteredOrders.length)} / {filteredOrders.length} phiếu
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="px-3 py-1.5 text-[10px] font-black uppercase rounded-lg border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none transition-all"
                    >
                      Trước
                    </button>
                    {Array.from({ length: tp }, (_, i) => i + 1)
                      .filter(p => p === 1 || p === tp || Math.abs(p - currentPage) <= 2)
                      .reduce<(number | string)[]>((acc, p, i, arr) => {
                        if (i > 0 && (arr[i - 1] as number) !== p - 1) acc.push('...');
                        acc.push(p);
                        return acc;
                      }, [])
                      .map((p, i) => typeof p === 'string' ? (
                        <span key={`dots-${i}`} className="px-1 text-slate-400 text-[10px]">...</span>
                      ) : (
                        <button
                          key={p}
                          onClick={() => setCurrentPage(p)}
                          className={`w-8 h-8 rounded-lg text-[11px] font-black transition-all ${currentPage === p ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'}`}
                        >
                          {p}
                        </button>
                      ))}
                    <button
                      onClick={() => setCurrentPage(p => Math.min(tp, p + 1))}
                      disabled={currentPage === tp}
                      className="px-3 py-1.5 text-[10px] font-black uppercase rounded-lg border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none transition-all"
                    >
                      Sau
                    </button>
                  </div>
                </div>
              );
            })()}
          </>
        );
      })()
        : (
          <div className="bg-white p-12 rounded-lg shadow-sm border border-gray-100 flex flex-col items-center justify-center text-gray-400 space-y-4">
            <Package size={48} className="opacity-20" />
            <p className="text-sm italic">Không tìm thấy lịch sử giao nhận nào.</p>
          </div>
        )}

      {/* Detail Modal */}
      <AnimatePresence>
        {selectedOrder && (
          <OrderDetailModal
            order={selectedOrder}
            onClose={() => setSelectedOrder(null)}
            logoBase64={logoBase64}
            onStartChecking={(ord) => {
              setActiveCheckingOrder(ord);
              setShowCheckingScanner(true);
            }}
          />
        )}
      </AnimatePresence>

      {/* Custom BO checking scan quantity modal */}
      <AnimatePresence>
        {pendingBoScan && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 10 }}
              className="bg-white rounded-lg shadow-2xl w-full max-w-sm overflow-hidden border border-slate-200 flex flex-col"
            >
              <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center border bg-indigo-100 text-indigo-600 border-indigo-100">
                    <CheckCircle size={22} />
                  </div>
                  <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">Cấu Kiện Bộ</h3>
                </div>
                <button
                  onClick={() => setPendingBoScan(null)}
                  className="p-2 text-slate-400 hover:text-rose-500 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="p-8 text-center space-y-7">
                <div className="space-y-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-indigo-600">
                    Nhập số lượng cấu kiện thực nhận thuộc Bộ
                  </p>
                  <div className="h-1 w-12 mx-auto rounded-full bg-indigo-500"></div>
                </div>

                <div className="bg-slate-100 p-6 rounded-lg border border-slate-100 space-y-4 text-left">
                  <div className="flex justify-between items-center border-b border-slate-200 pb-3">
                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Mã Module</span>
                    <span className="text-sm font-black text-slate-800 font-mono uppercase bg-white px-2 py-0.5 rounded-lg border border-slate-100">
                      {pendingBoScan.matchedItem.moduleCode}
                    </span>
                  </div>

                  <div className="flex justify-between items-center border-b border-slate-200 pb-3 bg-indigo-100/25 p-2 rounded-lg">
                    <span className="text-[10px] text-indigo-600 font-bold uppercase tracking-widest">Đã kiểm nhận</span>
                    <span className="text-xs font-black text-indigo-700">
                      {(pendingBoScan.matchedItem.checkedQty || 0)} / {pendingBoScan.matchedItem.quantity}
                    </span>
                  </div>

                  <div className="flex justify-between items-center pt-3">
                    <span className="text-[10px] text-indigo-600 font-black uppercase tracking-widest">Số lượng nhập</span>
                    <input
                      type="number"
                      min="1"
                      max={pendingBoScan.maxAllowed}
                      value={boScanQtyInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setBoScanQtyInput(val === '' ? '' : Math.max(1, Math.min(pendingBoScan.maxAllowed, parseInt(val, 10))));
                      }}
                      onFocus={(e) => e.target.select()}
                      placeholder="1"
                      className="w-20 px-2 py-1 text-center font-black text-xs text-indigo-600 border border-indigo-200 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="flex bg-slate-100 border-t border-slate-100 p-5 space-x-3">
                <button
                  onClick={() => setPendingBoScan(null)}
                  className="px-6 py-3 text-slate-600 font-black text-[10px] uppercase border border-slate-200 bg-white hover:bg-slate-100 rounded-lg transition-all tracking-widest"
                >
                  Hủy
                </button>

                <button
                  onClick={() => {
                    const qtyVal = Number(boScanQtyInput);
                    if (isNaN(qtyVal) || qtyVal <= 0) {
                      alert("Vui lòng nhập số lượng hợp lệ!");
                      return;
                    }
                    executeBoScanChecking(qtyVal);
                  }}
                  className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 shadow-xl shadow-emerald-100 text-white font-black uppercase text-[11px] tracking-widest transition-all rounded-lg flex items-center justify-center gap-2"
                >
                  Xác Nhận
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {showCheckingScanner && activeCheckingOrder && (
        <ScannerModal
          onClose={() => {
            setShowCheckingScanner(false);
            setActiveCheckingOrder(null);
          }}
          onScan={handleCheckingScanConfirm}
          projectEntries={projectEntriesForScanner}
        />
      )}
    </div>
  );
}

function OrderDetailModal({ order, onClose, logoBase64, onStartChecking }: { order: ShippingOrder, onClose: () => void, logoBase64: string | null, onStartChecking?: (order: ShippingOrder) => void }) {
  const { user, role, roles, hasRole } = useAuth();
  const [copied, setCopied] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedItems, setEditedItems] = useState<ShippingOrderItem[]>(order.items);
  const [projectEntries, setProjectEntries] = useState<ProjectEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [addSearchQuery, setAddSearchQuery] = useState('');
  const printRef = React.useRef<HTMLDivElement>(null);

  const isCheckable = order.type === 'ship' && !order.isChecked && (hasRole('admin') || hasRole('mod') || hasRole('mod_x1'));
  const canComplete = order.type === 'ship' && order.status !== 'completed' && (hasRole('admin') || hasRole('mod') || hasRole('mod_x1'));
  const canModify = hasRole('admin') || hasRole('mod_x1');

  // Danh sách module đã lọc theo dự án của phiếu + tên
  const filteredAddEntries = React.useMemo(() => {
    // Luôn lọc theo projectCode của phiếu, không cho thêm kiện từ dự án khác
    let result = projectEntries.filter(e => e.projectCode === order.projectCode);
    if (addSearchQuery.trim()) {
      const q = addSearchQuery.toLowerCase().trim();
      result = result.filter(e =>
        (e.moduleCode || '').toLowerCase().includes(q) ||
        (e.cluster || '').toLowerCase().includes(q)
      );
    }
    return result.filter(e => {
      const delivered = e.receivedQuantity || 0;
      const currentInOrder = order.items.find(i => i.id === e.id)?.quantity || 0;
      return (e.quantity - (delivered - currentInOrder)) > 0;
    });
  }, [projectEntries, addSearchQuery, order.projectCode, order.items]);

  const handleReturnOrder = async () => {
    if (!window.confirm("Bạn có chắc chắn muốn XOÁ phiếu này? Số lượng sẽ được hoàn trả lại cho dự án.")) return;
    setChecking(true);
    try {
      const batch = writeBatch(db);
      const projectReverts: { moduleId: string; data: Record<string, any>; projectCode?: string }[] = [];

      // 1. Revert quantities in projects
      for (const item of order.items) {
        if (!item.id) continue;
        let configId = await findProjectConfigId(item.projectCode || order.projectCode || '');
        if (!configId) continue;
        let entryDoc = await getDoc(doc(db, 'projectConfigs', configId, 'modules', item.id));
        if (!entryDoc.exists()) {
          const realConfigId = await findModuleConfigId(item.id);
          if (realConfigId && realConfigId !== configId) {
            configId = realConfigId;
            entryDoc = await getDoc(doc(db, 'projectConfigs', realConfigId, 'modules', item.id));
          }
        }
        if (entryDoc.exists()) {
          const entry = entryDoc.data() as ProjectEntry;
          const qty = item.quantity;

          const history = [...(entry.statusHistory || [])];
          if (order.type === 'receive') {
            const newReceived = Math.max(0, (entry.receivedQuantity || 0) - qty);
            const isFullyReceived = newReceived >= entry.quantity;
            const newStatus = newReceived === 0 ? 'QC - Đạt (Chờ nhận)' : (isFullyReceived ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận');

            history.push(`Hoàn phiếu nhận|${Date.now()}`);

            projectReverts.push({ moduleId: item.id, data: { receivedQuantity: newReceived, status: newStatus, statusHistory: history }, projectCode: entry.projectCode });
          } else {
            const newShipped = Math.max(0, (entry.shippedQuantity || 0) - qty);
            const isFullyShipped = newShipped >= entry.quantity;
            const newStatus = newShipped === 0 ? 'Giao Nhận - Đã nhận' : (isFullyShipped ? 'Giao Nhận - Đã giao' : 'Giao Nhận - Đang giao');

            history.push(`Hoàn phiếu giao|${Date.now()}`);

            projectReverts.push({ moduleId: item.id, data: { shippedQuantity: newShipped, status: newStatus, statusHistory: history }, projectCode: entry.projectCode });
          }
        }
      }

      // 2. Delete Order
      batch.delete(doc(db, 'shipping_orders', order.id));

      // 3. Activity Log
      const logRef = doc(collection(db, 'activities'));
      batch.set(logRef, cleanUndefinedFields({
        userId: user!.uid, userName: user!.displayName || 'Anonymous', userEmail: user!.email,
        action: 'Hoàn phiếu',
        details: `Đã hoàn (hủy) phiếu ${order.type === 'receive' ? 'nhận' : 'giao'} #${order.sequenceNumber} của dự án ${order.projectCode}`,
        projectCode: order.projectCode,
        timestamp: serverTimestamp()
      }));

      await batch.commit();
      if (projectReverts.length > 0) {
        await batchUpdateProjectModules(projectReverts);
      }
      alert("Đã hoàn phiếu thành công!");
      onClose();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'shipping_orders');
    } finally {
      setChecking(false);
    }
  };

  const toggleEdit = async () => {
    if (!isEditing) {
      setEditedItems([...order.items]);
      setIsEditing(true);
      if (projectEntries.length === 0) {
        setLoadingEntries(true);
        try {
          const uniqueCodes = Array.from(new Set(order.items.map(i => i.projectCode).filter(Boolean))) as string[];
          const codesToLoad = order.projectCode === 'MULTI' ? uniqueCodes : [order.projectCode];
          const allEntries: ProjectEntry[] = [];
          for (const code of codesToLoad) {
            const configId = await findProjectConfigId(code);
            if (configId) {
              const snap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
              snap.docs.forEach(d => allEntries.push({ id: d.id, ...d.data(), configId } as ProjectEntry));
            }
          }
          setProjectEntries(allEntries);
        } catch (err) {
          console.error("Load entries error:", err);
        } finally {
          setLoadingEntries(false);
        }
      }
    } else {
      setIsEditing(false);
      setShowAddMenu(false);
      setAddSearchQuery('');
    }
  };

  const saveEdits = async () => {
    if (!user) return;
    setChecking(true);
    try {
      const batch = writeBatch(db);
      const projectEditUpdates: { moduleId: string; data: Record<string, any>; projectCode?: string }[] = [];

      // Đối chiếu dự án lấy thông tin đồng bộ với module đó dựa trên moduleCode được chỉnh sửa
      const finalItems = [...editedItems];
      for (let i = 0; i < finalItems.length; i++) {
        const item = finalItems[i];
        const trimmedCode = (item.moduleCode || '').trim().toUpperCase();
        if (!trimmedCode) continue;

        let matchedModule: ProjectEntry | null = null;

        // Tìm thử trong projectEntries đã tải cục bộ
        const foundLocal = projectEntries.find(e => (e.moduleCode || '').trim().toUpperCase() === trimmedCode);
        if (foundLocal) {
          matchedModule = foundLocal;
        } else {
          // Search for moduleCode across projectConfigs/modules
          let found = false;
          if (order.projectCode !== 'MULTI') {
            const configId = await findProjectConfigId(order.projectCode);
            if (configId) {
              const q = query(collection(db, 'projectConfigs', configId, 'modules'), where('moduleCode', '==', item.moduleCode));
              const snap = await getDocs(q);
              if (!snap.empty) {
                matchedModule = { id: snap.docs[0].id, ...snap.docs[0].data(), configId } as ProjectEntry;
                found = true;
              }
            }
          }
          if (!found) {
            // Global fallback: search all configs
            const allConfigsSnap = await getDocs(collection(db, 'projectConfigs'));
            for (const cfgDoc of allConfigsSnap.docs) {
              const q = query(collection(db, 'projectConfigs', cfgDoc.id, 'modules'), where('moduleCode', '==', item.moduleCode));
              const snap = await getDocs(q);
              if (!snap.empty) {
                matchedModule = { id: snap.docs[0].id, ...snap.docs[0].data(), configId: cfgDoc.id } as ProjectEntry;
                break;
              }
            }
          }
        }

        if (matchedModule) {
          finalItems[i] = {
            ...item,
            id: matchedModule.id,
            moduleCode: matchedModule.moduleCode,
            name: matchedModule.moduleCode,
            width: matchedModule.width || 0,
            depth: matchedModule.depth || 0,
            height: matchedModule.height || 0,
            cluster: matchedModule.cluster || '',
            projectCode: matchedModule.projectCode,
            projectName: matchedModule.projectName || '',
            totalQty: matchedModule.quantity,
            previouslyDeliveredQty: matchedModule.receivedQuantity || 0
          };
        }
      }

      // We need to revert the OLD quantities and apply the NEW quantities in projects
      for (const oldItem of order.items) {
        if (!oldItem.id) continue;
        const configId = await findProjectConfigId(oldItem.projectCode || order.projectCode || '');
        if (!configId) continue;
        const entryDoc = await getDoc(doc(db, 'projectConfigs', configId, 'modules', oldItem.id));
        if (entryDoc.exists()) {
          const entry = entryDoc.data() as ProjectEntry;
          const reverted = Math.max(0, (entry.receivedQuantity || 0) - oldItem.quantity);
          projectEditUpdates.push({ moduleId: oldItem.id, data: { receivedQuantity: reverted }, projectCode: entry.projectCode || oldItem.projectCode || order.projectCode });
        }
      }

      for (const newItem of finalItems) {
        if (!newItem.id) continue;
        const configId = await findProjectConfigId(newItem.projectCode || order.projectCode || '');
        if (!configId) continue;
        const entryDoc = await getDoc(doc(db, 'projectConfigs', configId, 'modules', newItem.id));
        if (entryDoc.exists()) {
          const entry = entryDoc.data() as ProjectEntry;
          const oldItemForThis = order.items.find(i => i.id === newItem.id);
          const oldQty = oldItemForThis ? oldItemForThis.quantity : 0;

          const base = (entry.receivedQuantity || 0) - oldQty;
          const final = base + newItem.quantity;
          const isFully = final >= entry.quantity;
          const status = order.type === 'receive'
            ? (final === 0 ? 'QC - Đạt (Chờ nhận)' : (isFully ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận'))
            : (final === 0 ? 'Giao Nhận - Đã nhận' : (isFully ? 'Giao Nhận - Đã giao' : 'Giao Nhận - Đang giao'));
          projectEditUpdates.push({ moduleId: newItem.id, data: { receivedQuantity: final, status: status }, projectCode: entry.projectCode });
        }
      }

      batch.update(doc(db, 'shipping_orders', order.id), cleanUndefinedFields({
        items: finalItems,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      }));

      const logRef = doc(collection(db, 'activities'));
      batch.set(logRef, cleanUndefinedFields({
        userId: user.uid, userName: user.displayName || 'Anonymous', userEmail: user.email,
        action: 'Sửa phiếu',
        details: `Đã chỉnh sửa phiếu ${order.type === 'receive' ? 'nhận' : 'giao'} #${order.sequenceNumber} dự án ${order.projectCode}`,
        projectCode: order.projectCode,
        timestamp: serverTimestamp()
      }));

      await batch.commit();
      if (projectEditUpdates.length > 0) {
        await batchUpdateProjectModules(projectEditUpdates);
      }
      alert("Cập nhật phiếu thành công!");
      setIsEditing(false);
      onClose();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'shipping_orders');
    } finally {
      setChecking(false);
    }
  };

  const addModuleToOrder = (module: ProjectEntry) => {
    const existingIdx = editedItems.findIndex(i => i.id === module.id);
    if (existingIdx >= 0) {
      const next = [...editedItems];
      next[existingIdx] = { ...next[existingIdx], quantity: next[existingIdx].quantity + 1 };
      setEditedItems(next);
    } else {
      setEditedItems([...editedItems, {
        id: module.id,
        moduleCode: module.moduleCode,
        name: module.moduleCode,
        quantity: 1,
        totalQty: module.quantity,
        previouslyDeliveredQty: module.receivedQuantity || 0,
        width: module.width || 0,
        depth: module.depth || 0,
        height: module.height || 0,
        cluster: module.cluster,
        projectCode: module.projectCode,
        projectName: module.projectName,
        unit: 'cái'
      }]);
    }
    setShowAddMenu(false);
  };

  const removeItem = (idx: number) => {
    setEditedItems(prev => prev.filter((_, i) => i !== idx));
  };

  const updateItemQty = (idx: number, qty: number) => {
    setEditedItems(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], quantity: qty };
      return next;
    });
  };

  const createReceiptFromDelivery = async () => {
    if (!user) return;
    setChecking(true);
    try {
      const batch = writeBatch(db);
      const receiptProjectUpdates: { moduleId: string; data: Record<string, any>; projectCode?: string }[] = [];

      // Load projectEntries if they are not loaded yet for child-parent mapping
      let currentEntries = [...projectEntries];
      if (currentEntries.length === 0) {
        try {
          const uniqueCodes = Array.from(new Set(order.items.map(i => i.projectCode).filter(Boolean))) as string[];
          const codesToLoad = order.projectCode === 'MULTI' ? uniqueCodes : [order.projectCode];
          const allEntries: ProjectEntry[] = [];
          for (const code of codesToLoad) {
            const configId = await findProjectConfigId(code);
            if (configId) {
              const snap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
              snap.docs.forEach(d => allEntries.push({ id: d.id, ...d.data(), configId } as ProjectEntry));
            }
          }
          currentEntries = allEntries;
          setProjectEntries(currentEntries);
        } catch (err) {
          console.error("Load entries in createReceiptFromDelivery error:", err);
        }
      }

      // 1. Create Receipt Order
      const receiptRef = doc(collection(db, 'shipping_orders'));
      const receiptId = receiptRef.id;

      // Calculate sequence for the receipt
      const q = query(
        collection(db, 'shipping_orders'),
        where('projectCode', '==', order.projectCode),
        where('type', '==', 'receive')
      );
      const snap = await getDocs(q);
      const sequenceNumber = snap.size + 1;

      const receiptItems: ShippingOrderItem[] = order.items.map(item => ({
        ...item,
        quantity: item.quantity // Presume all items received correctly
      }));

      // Pre-process and create any missing child modules in Firestore for the receipt
      for (let i = 0; i < receiptItems.length; i++) {
        const item = receiptItems[i];
        if (!item.id && item.moduleCode) {
          const parentCodeCandidate = getParentCodeCandidate(item.moduleCode || '').toLowerCase();
          const parentEntry = currentEntries.find(e =>
            e.projectCode === order.projectCode &&
            ((e.moduleCode || '').toLowerCase() === parentCodeCandidate || (item.parentModuleCode && (e.moduleCode || '').toLowerCase() === (item.parentModuleCode || '').toLowerCase()))
          );

          if (parentEntry) {
            const newDocRef = doc(collection(db, 'projectConfigs', parentEntry.projectCode, 'modules'));
            const qty = item.quantity;
            const targetTotalQty = parentEntry.quantity || qty;
            const isFullyReceived = qty >= targetTotalQty;
            const newStatus = isFullyReceived ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận';
            const childType = getEntryType({ moduleCode: item.moduleCode } as any);

            const newProjectEntry: any = {
              projectName: parentEntry.projectName,
              projectCode: parentEntry.projectCode,
              cluster: parentEntry.cluster || '',
              moduleCode: item.moduleCode,
              quantity: targetTotalQty,
              receivedQuantity: qty,
              shippedQuantity: 0,
              status: newStatus,
              statusHistory: [`${newStatus}|${Date.now()}`],
              classification: childType || 'Cánh',
              ownerId: parentEntry.ownerId || user?.uid || 'system',
              createdAt: new Date(),
              sortIndex: (parentEntry.sortIndex || 0) + 1,
              pWidth: item.width || 0,
              pDepth: item.depth || 0,
              pHeight: item.height || 0,
              width: item.width || 0,
              depth: item.depth || 0,
              height: item.height || 0,
            };

            batch.set(newDocRef, cleanUndefinedFields(newProjectEntry));

            receiptItems[i] = {
              ...item,
              id: newDocRef.id
            };
          }
        }
      }

      batch.set(receiptRef, cleanUndefinedFields({
        type: 'receive',
        projectCode: order.projectCode,
        projectName: order.projectName,
        sequenceNumber,
        items: receiptItems,
        createdAt: new Date(),
        createdBy: user.uid,
        userName: user.displayName || 'Anonymous',
        userEmail: user.email,
        linkedShipOrderId: order.id
      }));

      // 2. Mark Ship Order as checked
      batch.update(doc(db, 'shipping_orders', order.id), {
        isChecked: true,
        linkedReceiptId: receiptId
      });

      // 3. Update Project Module Received Quantities
      for (const item of receiptItems) {
        if (!item.id) continue;

        // Skip if newly created (was just set in Firestore)
        const wasCreatedNew = order.items.some(oi => oi.moduleCode === item.moduleCode && !oi.id);
        if (wasCreatedNew) continue;

        let configId = await findProjectConfigId(item.projectCode || order.projectCode || '');
        if (!configId) continue;
        let entryDoc = await getDoc(doc(db, 'projectConfigs', configId, 'modules', item.id));
        if (!entryDoc.exists()) {
          const realConfigId = await findModuleConfigId(item.id);
          if (realConfigId && realConfigId !== configId) {
            configId = realConfigId;
            entryDoc = await getDoc(doc(db, 'projectConfigs', realConfigId, 'modules', item.id));
          }
        }
        if (entryDoc.exists()) {
          const entry = entryDoc.data();
          const currentReceived = entry.receivedQuantity || 0;
          const newReceived = currentReceived + item.quantity;
          const isFullyReceived = newReceived >= entry.quantity;
          const newStatus = isFullyReceived ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận';

          const history = [...(entry.statusHistory || [])];
          if (!history.length || history[history.length - 1].split('|')[0] !== newStatus) {
            history.push(`${newStatus}|${Date.now()}`);
          }

          receiptProjectUpdates.push({ moduleId: item.id, data: { receivedQuantity: newReceived, status: newStatus, statusHistory: history }, projectCode: entry.projectCode });
        }
      }

      // 4. Activity Log
      const logRef = doc(collection(db, 'activities'));
      batch.set(logRef, cleanUndefinedFields({
        userId: user.uid, userName: user.displayName || 'Anonymous', userEmail: user.email,
        action: 'Kiểm hàng nhận',
        details: `Nhận hàng thành công từ phiếu giao #${order.sequenceNumber || 1} của dự án ${order.projectCode}`,
        projectCode: order.projectCode,
        timestamp: serverTimestamp()
      }));

      await batch.commit();
      if (receiptProjectUpdates.length > 0) {
        await batchUpdateProjectModules(receiptProjectUpdates);
      }
      alert("Đã tạo phiếu nhập hàng từ phiếu giao này thành công!");
      onClose();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'shipping_orders');
    } finally {
      setChecking(false);
    }
  };

  const handleForceComplete = async () => {
    if (!user) return;
    if (!window.confirm("Hoàn tất phiếu này dù chưa kiểm đủ hàng? Phiếu sẽ chuyển sang trạng thái HOÀN THÀNH.")) return;
    setChecking(true);
    try {
      await updateDoc(doc(db, 'shipping_orders', order.id), {
        status: 'completed',
        isChecked: true,
        completedAt: new Date(),
        completedBy: user.uid,
        completedByName: user.displayName || 'Unknown'
      });

      const batch = writeBatch(db);
      const logRef = doc(collection(db, 'activities'));
      batch.set(logRef, cleanUndefinedFields({
        userId: user.uid, userName: user.displayName || 'Anonymous', userEmail: user.email,
        action: 'Hoàn tất phiếu',
        details: `Đã hoàn tất phiếu giao #${order.sequenceNumber || 1} của dự án ${order.projectCode} (không kiểm đủ)`,
        projectCode: order.projectCode,
        timestamp: serverTimestamp()
      }));
      await batch.commit();

      alert("Đã hoàn tất phiếu thành công!");
      onClose();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'shipping_orders');
    } finally {
      setChecking(false);
    }
  };

  const handleSyncProjectStatus = async () => {
    if (!user) return;
    if (!window.confirm("Đồng bộ số lượng nhận/giao từ phiếu này vào dự án?")) return;
    setChecking(true);
    try {
      // Với mỗi module trong phiếu, tìm trong projectConfigs/{projectCode}/modules và cập nhật
      const syncProjectUpdates: { moduleId: string; data: Record<string, any>; projectCode?: string }[] = [];

      for (const item of order.items) {
        if (!item.moduleCode || !item.projectCode) continue;
        const qty = item.quantity || 0;
        if (qty === 0) continue;

        // Tìm module theo moduleCode trong projectConfigs/{projectCode}/modules
        const modulesQ = query(
          collection(db, 'projectConfigs', item.projectCode, 'modules'),
          where('moduleCode', '==', item.moduleCode)
        );
        const modulesSnap = await getDocs(modulesQ);
        if (modulesSnap.empty) continue;

        const modDoc = modulesSnap.docs[0];
        const entry = modDoc.data() as ProjectEntry;
        const history = [...(entry.statusHistory || [])];

        const updateData: any = {};
        if (order.type === 'receive') {
          updateData.receivedQuantity = qty;
          const isFullyReceived = qty >= (entry.quantity || 1);
          updateData.status = isFullyReceived ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận';
        } else {
          updateData.shippedQuantity = qty;
          const isFullyShipped = qty >= (entry.quantity || 1);
          updateData.status = isFullyShipped ? 'Giao Nhận - Đã giao' : 'Giao Nhận - Đang giao';
        }

        const newStatus = updateData.status;
        if (!history.length || history[history.length - 1].split('|')[0] !== newStatus) {
          history.push(`${newStatus}|${Date.now()} (Đồng bộ)`);
        }
        updateData.statusHistory = history;

        syncProjectUpdates.push({ moduleId: modDoc.id, data: updateData, projectCode: item.projectCode });
      }

      // Ghi activity log
      const batch = writeBatch(db);
      const logRef = doc(collection(db, 'activities'));
      batch.set(logRef, cleanUndefinedFields({
        userId: user.uid, userName: user.displayName || 'Anonymous', userEmail: user.email,
        action: 'Đồng bộ phiếu',
        details: `Đồng bộ phiếu ${order.type === 'receive' ? 'nhận' : 'giao'} #${order.sequenceNumber || 1} vào dự án ${order.projectCode} — ${syncProjectUpdates.length} module`,
        projectCode: order.projectCode,
        timestamp: serverTimestamp()
      }));
      await batch.commit();

      // Ghi vào projectConfigs
      if (syncProjectUpdates.length > 0) {
        await batchUpdateProjectModules(syncProjectUpdates);
      }
      alert(`Đồng bộ thành công! ${syncProjectUpdates.length} module đã cập nhật.`);
      onClose();
    } catch (err: any) {
      console.error("Lỗi đồng bộ:", err);
      alert(`Đồng bộ thất bại: ${err.message || String(err)}`);
    } finally {
      setChecking(false);
    }
  };

  const copyShareLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('orderId', order.id);
    navigator.clipboard.writeText(url.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePrint = async () => {
    if (!printRef.current) return;
    setPrinting(true);
    try {
      // Small delay to ensure styles and images are rendered
      await new Promise(resolve => setTimeout(resolve, 800));

      const dataUrl = await toPng(printRef.current, {
        quality: 1,
        backgroundColor: '#ffffff',
        cacheBust: true,
        pixelRatio: 2,
      });
      const link = document.createElement('a');
      link.download = `Phieu-Nhan-Hang-${order.projectCode}-${order.id.slice(-6)}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err: any) {
      console.error('Print caught error:', err);
      alert(`Không thể tạo ảnh phiếu: ${err.message || 'CORS hoặc Render timeout'}. Vui lòng thử lại hoặc chụp màn hình.`);
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[200] p-4 backdrop-blur-sm">
      {/* Hidden Printable Component */}
      <div
        style={{ position: 'absolute', top: 0, left: 0, opacity: 0, pointerEvents: 'none', zIndex: -100 }}
      >
        <div ref={printRef} className="bg-white p-0 shadow-none border-0">
          <PrintableReceipt order={order} logoBase64={logoBase64} />
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="bg-white w-full max-w-6xl rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh] border border-slate-200"
      >
        <div className={`p-5 border-b flex items-center justify-between text-white ${order.type === 'receive' ? 'bg-emerald-600 shadow-lg shadow-emerald-100' : 'bg-indigo-600 shadow-lg shadow-indigo-100'}`}>
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center backdrop-blur-md">
              {order.type === 'receive' ? <CheckCircle size={24} /> : <Truck size={24} />}
            </div>
            <div>
              <h3 className="font-black text-sm uppercase tracking-widest leading-none">
                Phiếu {formatProjectCode(order.projectCode)} #{order.sequenceNumber || 1}
              </h3>
              <p className="text-[10px] uppercase font-bold mt-1 opacity-80 flex items-center gap-1.5">
                <Hash size={10} />
                Mã phiếu: {order.id.slice(-8).toUpperCase()}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            {canModify && (
              <button
                disabled={checking}
                onClick={handleReturnOrder}
                className="bg-rose-500/20 hover:bg-rose-500 text-white p-2 rounded-lg transition-all flex items-center justify-center md:px-4 md:space-x-2 h-10 border border-white/10"
                title="Xoá phiếu"
              >
                {checking ? <LoaderIcon size={16} className="animate-spin" /> : <Trash2 size={16} />}
                <span className="hidden md:inline font-black text-[10px] uppercase tracking-widest">Xoá phiếu</span>
              </button>
            )}
            {canModify && (
              <button
                disabled={checking}
                onClick={isEditing ? saveEdits : toggleEdit}
                className={`${isEditing ? 'bg-amber-500 hover:bg-amber-600' : 'bg-white/20 hover:bg-white/30'} text-white p-2 rounded-lg transition-all flex items-center justify-center md:px-4 md:space-x-2 h-10 border border-white/10`}
                title={isEditing ? 'Lưu thay đổi' : 'Sửa phiếu'}
              >
                {checking ? <LoaderIcon size={16} className="animate-spin" /> : (isEditing ? <CheckCircle size={16} /> : <Pencil size={16} />)}
                <span className="hidden md:inline font-black text-[10px] uppercase tracking-widest">{isEditing ? 'Lưu phiếu' : 'Sửa phiếu'}</span>
              </button>
            )}
            {isEditing && (
              <button
                onClick={toggleEdit}
                className="bg-white/10 hover:bg-white/20 text-white p-2 rounded-lg transition-all flex items-center justify-center md:px-4 md:space-x-2 h-10 border border-white/10"
                title="Hủy"
              >
                <X size={16} />
                <span className="hidden md:inline font-black text-[10px] uppercase tracking-widest">Hủy</span>
              </button>
            )}
            <button
              disabled={printing || isEditing}
              onClick={handlePrint}
              className="bg-white/10 hover:bg-white/20 text-white p-2 rounded-lg transition-all flex items-center justify-center md:px-4 md:space-x-2 h-10 border border-white/10"
              title="Lưu ảnh"
            >
              {printing ? <LoaderIcon size={16} className="animate-spin" /> : <Printer size={16} />}
              <span className="hidden md:inline font-black text-[10px] uppercase tracking-widest">{printing ? 'Đang tạo...' : 'Lưu ảnh'}</span>
            </button>
            {isCheckable && !isEditing && (
              <button
                disabled={checking}
                onClick={createReceiptFromDelivery}
                className="bg-white text-indigo-600 hover:bg-indigo-100 p-2 rounded-lg transition-all flex items-center justify-center md:px-4 md:space-x-2 h-10 shadow-sm"
                title="Kiểm hàng nhận"
              >
                {checking ? <LoaderIcon size={16} className="animate-spin" /> : <CheckCircle size={16} />}
                <span className="hidden md:inline font-black text-[10px] uppercase tracking-widest">Kiểm hàng</span>
              </button>
            )}
            {canComplete && !isEditing && (
              <button
                disabled={checking}
                onClick={handleForceComplete}
                className="bg-emerald-500 hover:bg-emerald-600 text-white p-2 rounded-lg transition-all flex items-center justify-center md:px-4 md:space-x-2 h-10 shadow-sm"
                title="Hoàn tất phiếu (dù chưa kiểm đủ)"
              >
                {checking ? <LoaderIcon size={16} className="animate-spin" /> : <Check size={16} />}
                <span className="hidden md:inline font-black text-[10px] uppercase tracking-widest">Hoàn tất</span>
              </button>
            )}
            {canModify && !isEditing && (
              <button
                disabled={checking}
                onClick={handleSyncProjectStatus}
                className="bg-white/10 hover:bg-white/20 text-white p-2 rounded-lg transition-all flex items-center justify-center md:px-4 md:space-x-2 h-10 border border-white/10"
                title="Đồng bộ tình trạng nhận/giao vào dự án"
              >
                {checking ? <LoaderIcon size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                <span className="hidden md:inline font-black text-[10px] uppercase tracking-widest">Đồng bộ dự án</span>
              </button>
            )}
            <button onClick={onClose} className="p-2 hover:bg-white/20 rounded-lg transition-colors ml-1">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-slate-100 flex flex-col md:flex-row custom-scrollbar">
          {/* Mobile View: Modern Cards (Hidden on MD+) */}
          <div className="md:hidden p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white p-3 rounded-xl shadow-sm border border-gray-100">
                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1">Dự án</p>
                <div className="flex items-center text-gray-800 font-black text-sm">
                  <Package size={14} className="mr-2 text-primary" />
                  {(() => {
                    const uniqueProjects = Array.from(new Set((order.items || []).map(i => i.projectCode).filter(Boolean)));
                    const names = uniqueProjects.map(code => {
                      const entry = order.items?.find(i => i.projectCode === code);
                      return entry?.projectName || formatProjectCode(code);
                    });
                    return names.join(', ') || 'Chưa xác định';
                  })()}
                </div>
              </div>
              <div className="bg-white p-3 rounded-xl shadow-sm border border-gray-100">
                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1">Mã dự án</p>
                <div className="flex items-center text-gray-800 font-bold text-xs">
                  <Hash size={14} className="mr-2 text-primary" />
                  {Array.from(new Set((order.items || []).map(i => i.projectCode).filter(Boolean))).join(', ') || order.projectCode}
                </div>
              </div>
              <div className="bg-white p-3 rounded-xl shadow-sm border border-gray-100">
                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1">Người lập</p>
                <div className="flex items-center text-gray-800 font-medium text-xs">
                  <User size={14} className="mr-2 text-primary" />
                  {order.userName}
                </div>
              </div>
              <div className="bg-white p-3 rounded-xl shadow-sm border border-gray-100">
                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1">Số lượng</p>
                <div className="flex items-center text-primary font-black text-xs">
                  <FileText size={14} className="mr-2" />
                  {order.items.reduce((sum, item) => sum + (item.quantity || 0), 0)} cấu kiện
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Danh sách hạng mục</h4>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setShowAddMenu(!showAddMenu)}
                    className="p-1 px-2 flex items-center gap-1 bg-indigo-100 text-indigo-600 border border-indigo-200 text-[9px] font-black uppercase rounded shadow-sm active:scale-95 transition-transform"
                  >
                    <Plus size={12} />
                    Thủ công
                  </button>
                  <button
                    onClick={() => {
                      onStartChecking?.(order);
                    }}
                    className="p-1 px-2 flex items-center gap-1 bg-emerald-500 text-white text-[9px] font-black uppercase rounded shadow-sm active:scale-95 transition-transform"
                  >
                    <ScanQrCode size={12} />
                    Quét QR
                  </button>
                </div>
              </div>

              {showAddMenu && (
                <div className="bg-white border border-primary/20 rounded-xl p-3 shadow-xl space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                  <div className="flex items-center justify-between border-b pb-1 mb-2">
                    <span className="text-[9px] font-black text-primary uppercase">Chọn module bổ sung</span>
                    <button onClick={() => { setShowAddMenu(false); setAddSearchQuery(''); }} className="text-gray-400"><X size={14} /></button>
                  </div>
                  {/* Ô tìm kiếm theo tên */}
                  <div className="relative">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      placeholder="Lọc theo tên module, khu vực..."
                      value={addSearchQuery}
                      onChange={e => setAddSearchQuery(e.target.value)}
                      className="w-full border border-gray-200 bg-gray-50 rounded-lg pl-7 pr-2 py-1.5 text-[10px] font-bold text-gray-700 outline-none focus:border-primary"
                    />
                  </div>
                  <p className="text-[9px] text-gray-400 font-bold">Chỉ hiển thị module dự án <span className="text-primary">{formatProjectCode(order.projectCode)}</span></p>
                  <div className="max-h-60 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                    {loadingEntries ? (
                      <div className="py-4 text-center text-[10px] text-gray-400 font-bold italic">Đang tải danh sách...</div>
                    ) : filteredAddEntries.length > 0 ? (
                      filteredAddEntries.map(e => (
                          <button
                            key={e.id}
                            onClick={() => addModuleToOrder(e)}
                            className="w-full text-left p-2 hover:bg-blue-100 flex items-center justify-between rounded border border-transparent hover:border-blue-100 transition-all"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-[11px] font-black text-gray-800 truncate">{e.moduleCode}</p>
                              <p className="text-[9px] text-gray-400 font-bold uppercase truncate">{e.cluster}</p>
                            </div>
                            <span className="ml-2 text-[10px] bg-blue-100 text-primary px-1.5 rounded font-black shrink-0">
                              Chọn
                            </span>
                          </button>
                        ))
                    ) : (
                      <div className="py-4 text-center text-[10px] text-gray-400">Không có module nào phù hợp</div>
                    )}
                  </div>
                </div>
              )}

              {(isEditing ? editedItems : order.items).map((item, idx) => (
                <div key={idx} className={`bg-white p-3 rounded-xl shadow-sm border transition-all ${isEditing ? 'border-orange-100 bg-orange-100/10' : 'border-gray-100'} flex justify-between items-center group`}>
                  <div className="flex-1 min-w-0 font-sans">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="bg-gray-100 text-gray-500 text-[10px] px-1.5 py-0.5 rounded font-black">{idx + 1}</span>
                      {isEditing ? (
                        <div className="flex items-center gap-2 flex-1">
                          <input
                            type="text"
                            className="bg-white border border-orange-200 px-2.5 py-1 rounded text-xs font-black text-gray-800 focus:border-orange-400 focus:ring-1 focus:ring-orange-400 outline-none uppercase flex-1 min-w-[150px] max-w-[320px]"
                            value={item.moduleCode || ''}
                            onChange={(e) => {
                              const next = [...editedItems];
                              next[idx] = { ...next[idx], moduleCode: e.target.value, name: e.target.value };
                              setEditedItems(next);
                            }}
                            placeholder="Mã module..."
                          />
                          <button
                            onClick={() => removeItem(idx)}
                            className="p-1 text-red-400 hover:text-red-500 transition-colors shrink-0"
                            title="Xóa dòng"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ) : (
                        <p className="text-sm font-black text-gray-900 truncate uppercase">{item.moduleCode || item.name}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-gray-500 font-bold uppercase">
                      {(item.projectCode || order.projectCode !== 'unassigned') && (
                        <span className="text-indigo-600 font-black">{formatProjectCode(item.projectCode || order.projectCode)}</span>
                      )}
                      <span>{item.cluster || 'Khu vực N/A'}</span>
                      {item.width && <span>{item.width}x{item.depth}x{item.height}</span>}
                    </div>
                  </div>
                  <div className="text-right ml-4 flex items-center gap-2">
                    {isEditing ? (
                      <div className="flex items-center gap-1.5 bg-white p-1 rounded-lg border border-orange-200">
                        <button
                          onClick={() => updateItemQty(idx, Math.max(1, item.quantity - 1))}
                          className="w-6 h-6 bg-gray-100 rounded-md flex items-center justify-center text-xs font-black active:bg-gray-200"
                        >
                          -
                        </button>
                        <input
                          type="number"
                          className="w-8 text-center text-xs font-black bg-transparent outline-none"
                          value={item.quantity}
                          onChange={(e) => updateItemQty(idx, Math.max(1, Number(e.target.value)))}
                        />
                        <button
                          onClick={() => updateItemQty(idx, item.quantity + 1)}
                          className="w-6 h-6 bg-gray-100 rounded-md flex items-center justify-center text-xs font-black active:bg-gray-200"
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="text-xs font-black text-primary">x{item.quantity}</p>
                        <p className="text-[9px] text-gray-400 uppercase">{item.unit || 'cái'}</p>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Desktop Edit Sidebar (visible only when editing on MD+) */}
          {isEditing && (
            <div className="hidden md:block w-96 bg-white border-r border-gray-200 p-6 space-y-6 overflow-y-auto">
              <div className="flex items-center justify-between border-b pb-2">
                <h4 className="text-xs font-black text-gray-400 uppercase tracking-widest">Hiệu chỉnh hạng mục</h4>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setShowAddMenu(!showAddMenu)}
                    className="p-1 px-3 flex items-center gap-1 bg-indigo-100 text-indigo-600 border border-indigo-200 text-[10px] font-black uppercase rounded shadow-sm active:scale-95 transition-all"
                  >
                    <Plus size={14} />
                    Thủ công
                  </button>
                  <button
                    onClick={() => {
                      onStartChecking?.(order);
                    }}
                    className="p-1 px-3 flex items-center gap-1 bg-emerald-500 hover:bg-emerald-600 text-white text-[10px] font-black uppercase rounded shadow-md active:scale-95 transition-all"
                  >
                    <ScanQrCode size={14} />
                    Quét QR
                  </button>
                </div>
              </div>

              {showAddMenu && (
                <div className="bg-gray-100 border border-primary/20 rounded-xl p-4 shadow-xl space-y-3">
                  <div className="flex items-center justify-between border-b border-gray-200 pb-2">
                    <span className="text-[10px] font-black text-primary uppercase tracking-tight">Danh sách module của dự án</span>
                    <button onClick={() => { setShowAddMenu(false); setAddSearchQuery(''); }} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
                  </div>
                  {/* Ô tìm kiếm theo tên */}
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      placeholder="Lọc theo tên module, khu vực..."
                      value={addSearchQuery}
                      onChange={e => setAddSearchQuery(e.target.value)}
                      className="w-full border border-gray-200 bg-white rounded-lg pl-9 pr-3 py-2 text-xs font-bold text-gray-700 outline-none focus:border-primary"
                    />
                  </div>
                  <p className="text-[9px] text-gray-400 font-bold">Chỉ hiển thị module dự án <span className="text-primary">{formatProjectCode(order.projectCode)}</span></p>
                  <div className="max-h-[400px] overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                    {loadingEntries ? (
                      <div className="py-8 text-center text-xs text-gray-400 font-bold italic">Đang truy vấn dữ liệu...</div>
                    ) : filteredAddEntries.length > 0 ? (
                      filteredAddEntries.map(e => (
                          <button
                            key={e.id}
                            onClick={() => addModuleToOrder(e)}
                            className="w-full text-left p-3 hover:bg-blue-100 flex items-center justify-between rounded-lg border border-transparent hover:border-blue-100 transition-all group"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-black text-gray-800 group-hover:text-primary transition-colors">{e.moduleCode}</p>
                              <p className="text-[10px] text-gray-400 font-bold uppercase truncate">{e.cluster}</p>
                            </div>
                            <span className="ml-3 text-[10px] bg-white text-primary px-2 py-1 rounded border border-primary/20 font-black shrink-0 group-hover:bg-primary group-hover:text-white transition-all">
                              Chọn
                            </span>
                          </button>
                        ))
                    ) : (
                      <div className="py-8 text-center text-xs text-gray-400 italic">Không có module nào phù hợp</div>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {editedItems.map((item, idx) => (
                  <div key={idx} className="p-4 border border-orange-100 bg-orange-100/20 rounded-xl flex flex-col gap-3 shadow-sm hover:shadow-md transition-shadow">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="bg-orange-100 text-orange-600 text-[10px] px-1.5 py-0.5 rounded font-black">{idx + 1}</span>
                        <input type="text" className="bg-white border border-orange-200 px-1.5 py-0.5 rounded text-xs font-black text-gray-800 focus:border-orange-400 focus:ring-1 focus:ring-orange-400 outline-none uppercase flex-1 min-w-[200px] ml-1" value={item.moduleCode || ''} onChange={(e) => { const next = [...editedItems]; next[idx] = { ...next[idx], moduleCode: e.target.value, name: e.target.value }; setEditedItems(next); }} />
                      </div>
                      <button onClick={() => removeItem(idx)} className="p-1.5 text-red-300 hover:text-red-500 hover:bg-red-100 rounded-full transition-all">
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between border-t border-orange-100 pt-2">
                      <span className="text-[10px] text-gray-400 font-bold uppercase">{item.cluster || 'N/A'}</span>
                      <div className="flex items-center gap-2 bg-white p-1 rounded-lg border border-orange-100">
                        <button onClick={() => updateItemQty(idx, Math.max(1, item.quantity - 1))} className="w-6 h-6 flex items-center justify-center text-xs font-black hover:bg-gray-100 rounded">-</button>
                        <input
                          type="number"
                          className="w-8 text-center text-xs font-black bg-transparent outline-none"
                          value={item.quantity}
                          onChange={(e) => updateItemQty(idx, Math.max(1, Number(e.target.value)))}
                        />
                        <button onClick={() => updateItemQty(idx, item.quantity + 1)} className="w-6 h-6 flex items-center justify-center text-xs font-black hover:bg-gray-100 rounded">+</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Desktop View: Receipt Preview (Hidden on small screens) */}
          <div className="hidden md:block flex-1 bg-gray-200 p-8 overflow-auto custom-scrollbar">
            <div className="mx-auto bg-white shadow-2xl origin-top" style={{ width: '1000px' }}>
              <PrintableReceipt order={{ ...order, items: editedItems }} logoBase64={logoBase64} />
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function PrintableReceipt({ order, logoBase64 }: { order: ShippingOrder, logoBase64: string | null }) {
  const date = parseFirestoreDate(order.createdAt, order.id);

  return (
    <div
      style={{
        fontFamily: '"Times New Roman", Times, serif',
        width: '1000px',
        paddingLeft: '34px',
        paddingTop: '32px',
        paddingRight: '34px',
        paddingBottom: '32px'
      }}
      className="bg-white text-black leading-tight"
    >
      {/* Header Branding Image Banner */}
      <div className="mb-6 w-full border border-black">
        {logoBase64 ? (
          <img
            src={logoBase64}
            alt="Company Header"
            className="w-full h-auto block"
          />
        ) : (
          <div className="p-12 text-center bg-gray-100 italic text-gray-400">
            Đang tải ảnh đầu trang...
          </div>
        )}
      </div>

      {/* Title */}
      <div className="text-center">
        <h1 className="text-2xl font-black uppercase tracking-widest text-[#1a1a1a]">NHẬT KÝ XE TẢI GIAO HÀNG</h1>
        <p className="italic">(NM1 giao NM2)</p>
      </div>

      {/* Date */}
      <div className="mb-4 text-[13px] italic font-medium flex justify-between items-center">
        <span>Ngày {date.getDate().toString().padStart(2, '0')} Tháng {(date.getMonth() + 1).toString().padStart(2, '0')} Năm {date.getFullYear()}</span>
        <span className="font-black text-red-600 uppercase tracking-wider bg-red-100 px-3 py-1 rounded-sm border border-red-100">
          Chuyến xe #{order.sequenceNumber || 1} - Lúc {date.getHours().toString().padStart(2, '0')}:{date.getMinutes().toString().padStart(2, '0')}
        </span>
      </div>

      {/* Main Table */}
      <table className="w-full border-collapse border border-black text-[11px] text-center">
        <thead>
          <tr className="bg-[#ffc107] font-black uppercase tracking-tight border-b border-black">
            <th className="px-1 py-1 w-[40px] border-r border-black" rowSpan={2}>STT</th>
            <th className="px-2 py-1 w-[120px] border-r border-black" rowSpan={2}>DỰ ÁN</th>
            <th className="px-2 py-1 w-[140px] border-r border-black" rowSpan={2}>KHU VỰC</th>
            <th className="px-2 py-1 border-r border-black" rowSpan={2}>TÊN CHI TIẾT</th>
            <th className="px-2 py-1 border-r border-black" colSpan={3}>KÍCH THƯỚC</th>
            <th className="px-1 py-1 w-[60px] border-r border-black" rowSpan={2}>SL GIAO</th>
            <th className="px-1 py-1 w-[60px]" rowSpan={2}>ĐVT</th>
          </tr>
          <tr className="bg-[#ffc107] font-black uppercase border-b border-black">
            <th className="px-1 py-1 w-[50px] border-r border-black">Dài</th>
            <th className="px-1 py-1 w-[50px] border-r border-black">Rộng</th>
            <th className="px-1 py-1 w-[50px] border-r border-black">Cao</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-black font-black text-gray-900 border-b border-black">
          {order.items.map((item, idx) => (
            <tr key={idx} className="text-[11px] font-black">
              <td className="px-1 py-1 border-r border-black">{idx + 1}</td>
              <td className="px-2 py-1 uppercase border-r border-black">
                {formatProjectCode(item.projectCode || order.projectCode)}
              </td>
              <td className="px-2 py-1 uppercase tracking-tighter border-r border-black">{item.cluster || 'N/A'}</td>
              <td className="px-2 py-1 truncate border-r border-black">{item.moduleCode || item.name}</td>
              <td className="px-1 py-1 border-r border-black">{item.width || ''}</td>
              <td className="px-1 py-1 border-r border-black">{item.depth || ''}</td>
              <td className="px-1 py-1 border-r border-black">{item.height || ''}</td>
              <td className="px-1 py-1 text-[13px] border-r border-black">{item.quantity}</td>
              <td className="px-1 py-1">{item.unit || 'cái'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Footer / Signatures */}
      <div className="mt-12 flex justify-between text-center font-black text-[11px]">
        <div className="w-[200px] flex flex-col items-center">
          <p className="mb-2 italic underline">Người giao hàng</p>
          <p className="font-black text-[13px] text-gray-900 uppercase">Nguyễn Văn Ngọt Em</p>
          <p className="opacity-30 font-normal italic text-[9px] mt-1">(Ký, họ và tên)</p>
        </div>
        <div className="w-[200px] flex flex-col items-center">
          <p className="mb-2 italic underline">Người nhận hàng</p>
          <p className="font-black text-[13px] text-gray-900 uppercase">Lê Quang Nhị</p>
          <p className="opacity-30 font-normal italic text-[9px] mt-1">(Ký, họ và tên)</p>
        </div>
        <div className="w-[200px] flex flex-col items-center">
          <p className="mb-2 italic underline">QC</p>
          <p className="font-black text-[13px] text-gray-900 uppercase">Lê Ngọc Huy</p>
          <p className="opacity-30 font-normal italic text-[9px] mt-1">(Ký, họ và tên)</p>
        </div>
      </div>
    </div>
  );
}

function Loader2({ className, size }: { className?: string, size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size || 24}
      height={size || 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}
