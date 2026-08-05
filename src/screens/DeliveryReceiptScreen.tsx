/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Package, Loader2, CheckCircle, Boxes, Truck, Plus, Trash2, X, Clock, ScanQrCode, Check, AlertTriangle, RefreshCw, ArrowLeft
} from 'lucide-react';
import {
  doc, writeBatch, collection, serverTimestamp, query, where, getDocs, getDoc, onSnapshot, updateDoc, addDoc
} from 'firebase/firestore';
import { useAuth } from '../lib/AuthContext';
import { db, handleFirestoreError, OperationType, cleanUndefinedFields } from '../lib/firebase';
import { ProjectEntry, ShippingOrderItem, ShippingOrder, getModuleInstances, matchSearchQuery, getModuleQcAggregate } from '../types';
import { DeliveryListScreen } from './DeliveryListScreen';
import { getEntryType, getParentCodeCandidate } from './ProjectManagementScreen';
import { ScannerModal, ScannedResult } from '../components/ScannerModal';
import { formatProjectCode, formatProjectName } from '../lib/formatters';
import { useAlert } from '../lib/AlertContext';
import { batchUpdateProjectModules, updateProjectModule, findProjectConfigId, findModuleConfigId } from '../lib/dualWrite';

interface DeliveryReceiptScreenProps {
  projectEntries: ProjectEntry[];
  onComplete?: () => void;
  initialOrderId?: string | null;
  onNavigatePacking?: (moduleCode: string) => void;
  onSelectOrder?: (orderId: string) => void;
}

export function DeliveryReceiptScreen({ projectEntries, onComplete, initialOrderId, onNavigatePacking, onSelectOrder }: DeliveryReceiptScreenProps) {
  const { user, role, roles, userProfile, hasRole } = useAuth();
  const { showSuccess, showError, showWarning, showInfo } = useAlert();
  const [activeTab, setActiveTab] = useState<'receive' | 'ship'>('ship');
  const [loading, setLoading] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [showManualAddToExisting, setShowManualAddToExisting] = useState(false);
  const [manualAddToExistingSearch, setManualAddToExistingSearch] = useState('');
  const [manualAddToExistingProject, setManualAddToExistingProject] = useState('');
  const [manualAddToExistingMode, setManualAddToExistingMode] = useState<'thung' | 'hang_son' | 'all'>('all');
  const [showCheckingScanner, setShowCheckingScanner] = useState(false);
  const [scannedResult, setScannedResult] = useState<ScannedResult | null>(null);
  const [scanConfirmQty, setScanConfirmQty] = useState<number | ''>(1);
  const [manualAddProject, setManualAddProject] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [manualAddMode, setManualAddMode] = useState<'thung' | 'hang_son' | 'all'>('thung');
  const [manualSearchQuery, setManualSearchQuery] = useState('');
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [activeOrder, setActiveOrder] = useState<ShippingOrder | null>(null);

  // Real-time listener cho phiếu đang xem
  useEffect(() => {
    if (!activeOrderId) { setActiveOrder(null); return; }
    const unsub = onSnapshot(doc(db, 'shipping_orders', activeOrderId), (snap) => {
      if (snap.exists()) {
        setActiveOrder({ id: snap.id, ...snap.data() } as ShippingOrder);
      } else {
        setActiveOrderId(null);
        setActiveOrder(null);
      }
    }, () => {
      setActiveOrderId(null);
      setActiveOrder(null);
    });
    return () => unsub();
  }, [activeOrderId]);

  const isAuthorized = hasRole('admin') || hasRole('mod') || hasRole('mod_x1') || hasRole('mod_x2') || hasRole('mod_qc');

  // Tạo phiếu giao/nhận TRỐNG với ID theo ngày giờ
  const handleCreateEmptyOrder = async (type: 'ship' | 'receive') => {
    try {
      setLoading(true);
      const displayLabel = userProfile?.ten_that || user?.displayName || 'Unknown';
      const now = new Date();
      const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const typeLabel = type === 'ship' ? 'Giao' : 'Nhận';

      const orderDoc = {
        type,
        title: `Phiếu ${typeLabel.toLowerCase()} - ${now.toLocaleDateString('vi-VN')}`,
        projectCode: '',
        items: [],
        createdAt: now,
        createdBy: user?.uid || '',
        userName: displayLabel,
        userEmail: user?.email || '',
        status: 'pending'
      };

      const docRef = await addDoc(collection(db, 'shipping_orders'), orderDoc);

      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: `Tạo phiếu ${typeLabel.toLowerCase()}`,
        details: `Tạo phiếu ${typeLabel.toLowerCase()} trống mới`,
        timestamp: serverTimestamp()
      });

      setActiveOrderId(docRef.id);
      showSuccess(`Đã tạo phiếu ${typeLabel.toLowerCase()} thành công!`);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'shipping_orders');
    } finally {
      setLoading(false);
    }
  };

  // QC White check: yêu cầu pass trước khi giao hàng, không yêu cầu khi nhận hàng

  const resolveModule = (idOrCode: string, projectCode?: string): ProjectEntry | undefined => {
    const byId = projectEntries.find(e => e.id === idOrCode);
    if (byId) return byId;
    return projectEntries.find(e => e.moduleCode?.toLowerCase() === idOrCode.toLowerCase() && (!projectCode || e.projectCode === projectCode));
  };

  // --- Main State for the current receipt/shipment ---
  const [stagedItems, setStagedItems] = useState<ShippingOrderItem[]>([]);
  const [pendingShipOrders, setPendingShipOrders] = useState<ShippingOrder[]>([]);

  const projects = Array.from(new Set(projectEntries.map(p => p.projectCode))).sort();

  // Listen for pending ship orders to auto-sync checkedQty
  useEffect(() => {
    const qPending = query(
      collection(db, 'shipping_orders'),
      where('type', '==', 'ship'),
      where('status', '==', 'pending')
    );
    const qPendingQc = query(
      collection(db, 'shipping_orders'),
      where('type', '==', 'ship'),
      where('status', '==', 'pending_qc')
    );

    let ordersMap = new Map<string, ShippingOrder>();

    const unsubPending = onSnapshot(qPending, (snap) => {
      snap.docChanges().forEach(change => {
        if (change.type === 'removed') {
          ordersMap.delete(change.doc.id);
        } else {
          ordersMap.set(change.doc.id, { id: change.doc.id, ...change.doc.data() } as ShippingOrder);
        }
      });
      setPendingShipOrders(Array.from(ordersMap.values()));
    }, () => {});

    const unsubPendingQc = onSnapshot(qPendingQc, (snap) => {
      snap.docChanges().forEach(change => {
        if (change.type === 'removed') {
          ordersMap.delete(change.doc.id);
        } else {
          ordersMap.set(change.doc.id, { id: change.doc.id, ...change.doc.data() } as ShippingOrder);
        }
      });
      setPendingShipOrders(Array.from(ordersMap.values()));
    }, () => {});

    return () => { unsubPending(); unsubPendingQc(); };
  }, []);

  // Auto-sync checkedQty to pending ship orders when receiving
  const syncCheckedQtyToShipOrders = async (moduleCode: string, qty: number, scannedInstanceIds?: string[]) => {
    if (!pendingShipOrders.length) return;
    for (const order of pendingShipOrders) {
      const matchedItemIdx = order.items.findIndex(item =>
        item.moduleCode?.toLowerCase() === moduleCode.toLowerCase()
      );
      if (matchedItemIdx === -1) continue;

      const matchedItem = order.items[matchedItemIdx];
      const currentChecked = matchedItem.checkedQty || 0;
      const remaining = matchedItem.quantity - currentChecked;
      if (remaining <= 0) continue;

      const qtyToAdd = Math.min(qty, remaining);
      let nextScannedIds = [...(matchedItem.scannedInstanceIds || [])];
      if (scannedInstanceIds) {
        nextScannedIds = Array.from(new Set([...nextScannedIds, ...scannedInstanceIds]));
      }

      const updatedItems = order.items.map((item, idx) => {
        if (idx === matchedItemIdx) {
          return { ...item, checkedQty: currentChecked + qtyToAdd, scannedInstanceIds: nextScannedIds };
        }
        return item;
      });

      const isAllCompleted = updatedItems.every(item => (item.checkedQty || 0) >= item.quantity);
      const nextStatus = isAllCompleted ? 'completed' : 'pending';

      try {
        await updateDoc(doc(db, 'shipping_orders', order.id), {
          items: updatedItems,
          status: nextStatus
        });
      } catch (err) {
        console.error("Auto-sync checkedQty error:", err);
      }
    }
  };

  // Xuly quet QR nhan hang - them vao phieu nhan va dong bo voi phieu giao
  const handleCheckingScan = async (result: ScannedResult) => {
    if (!activeOrder || activeOrder.type !== 'receive') return;
    const rawText = (result.rawCode || result.moduleCode || '').trim();
    if (!rawText) return;

    // Tim module phu hop — ưu tiên resolveModule (fresh DB lookup giống thêm thủ công)
    let matchedEntry = resolveModule(result.matchedId || '', result.projectCode);
    if (!matchedEntry && result.instanceId) {
      const possible = resolveModule(result.parsedModuleId || '', result.projectCode);
      if (possible) matchedEntry = possible;
    }
    if (!matchedEntry) {
      matchedEntry = projectEntries.find(e =>
        e.id === result.matchedId ||
        (e.moduleCode || '').toLowerCase() === rawText.toLowerCase()
      );
    }
    if (!matchedEntry) {
      const cleanCode = rawText.replace(/^\d+\./, '').replace(/-\d+\/\d+$/, '');
      matchedEntry = projectEntries.find(e =>
        (e.moduleCode || '').toLowerCase() === cleanCode.toLowerCase()
      );
    }
    if (!matchedEntry) {
      matchedEntry = getMatchedEntryDelivery(result);
    }

    if (!matchedEntry) {
      showError(`Không tìm thấy module "${rawText.slice(0, 30)}" trong hệ thống!`);
      return;
    }

    const moduleCode = matchedEntry.moduleCode || rawText;
    const qtyToAdd = typeof scanConfirmQty === 'number' && scanConfirmQty > 0 ? scanConfirmQty : 1;

    // Xac dinh instance da nhan — LUÔN đọc fresh từ Firestore để tìm instance idle tiếp theo
    let scannedInstanceId = result.instanceId;
    if (matchedEntry?.id && matchedEntry?.projectCode) {
      try {
        const freshConfigId = matchedEntry.configId || await findProjectConfigId(matchedEntry.projectCode);
        if (freshConfigId) {
          const freshSnap = await getDoc(doc(db, 'projectConfigs', freshConfigId, 'modules', matchedEntry.id));
          if (freshSnap.exists()) {
            const freshInstances = getModuleInstances(freshSnap.data() as ProjectEntry);
            // Nếu scannedInstanceId từ QR đã set, kiểm tra xem nó có idle không
            if (scannedInstanceId) {
              const matchedInst = freshInstances.find(inst => inst.instanceId === scannedInstanceId || inst.id === scannedInstanceId);
              if (matchedInst && !matchedInst.delivered) {
                // Instance từ QR vẫn idle → giữ nguyên
              } else {
                // Instance từ QR đã delivered hoặc không tồn tại → tìm instance idle tiếp theo
                const idleInst = freshInstances.find(inst => !inst.delivered);
                scannedInstanceId = idleInst ? (idleInst.instanceId || idleInst.id) : (freshInstances[0]?.instanceId || freshInstances[0]?.id || `${moduleCode}|1`);
              }
            } else {
              const idleInst = freshInstances.find(inst => !inst.delivered);
              scannedInstanceId = idleInst ? (idleInst.instanceId || idleInst.id) : (freshInstances[0]?.instanceId || freshInstances[0]?.id || `${moduleCode}|1`);
            }
          }
        }
      } catch (e) {
        // Fallback: dùng stale data
      }
    }
    if (!scannedInstanceId) {
      const instances = getModuleInstances(matchedEntry);
      const idleInst = instances.find(inst => !inst.delivered);
      if (idleInst) {
        scannedInstanceId = idleInst.instanceId || idleInst.id;
      } else {
        scannedInstanceId = instances[0]?.instanceId || instances[0]?.id || `${moduleCode}|1`;
      }
    }

    // Xac dinh syncStatus: module co trong phieu giao cho khong?
    const isInShipOrder = pendingShipOrders.some(order =>
      order.items?.some(item =>
        (item.moduleCode || '').toLowerCase() === moduleCode.toLowerCase()
        && (item.checkedQty || 0) < item.quantity
      )
    );
    const syncStatus: 'synced' | 'unmatched' = isInShipOrder ? 'synced' : 'unmatched';

    // Them vao phieu nhan
    const currentItems = activeOrder.items || [];
    const existingIdx = currentItems.findIndex(
      item => (item.moduleCode || '').toLowerCase() === moduleCode.toLowerCase()
    );

    let updatedItems;
    if (existingIdx >= 0) {
      updatedItems = currentItems.map((item, idx) => {
        if (idx === existingIdx) {
          const mergedIds = Array.from(new Set([...(item.scannedInstanceIds || []), ...(scannedInstanceId ? [scannedInstanceId] : [])]));
          return { ...item, quantity: (item.quantity || 0) + qtyToAdd, scannedInstanceIds: mergedIds, syncStatus };
        }
        return item;
      });
    } else {
      const newItem: ShippingOrderItem = {
        id: matchedEntry.id || '',
        moduleCode,
        name: moduleCode,
        quantity: qtyToAdd,
        width: matchedEntry.pWidth || matchedEntry.width || 0,
        depth: matchedEntry.pDepth || matchedEntry.depth || 0,
        height: matchedEntry.pHeight || matchedEntry.height || 0,
        cluster: matchedEntry.cluster || '',
        projectCode: matchedEntry.projectCode || activeOrder.projectCode,
        projectName: matchedEntry.projectName || '',
        scannedInstanceIds: scannedInstanceId ? [scannedInstanceId] : [],
        syncStatus
      };
      updatedItems = [newItem, ...currentItems];
    }

    await updateDoc(doc(db, 'shipping_orders', activeOrder.id), { items: updatedItems });

    // Dong bo vao phieu giao — query trực tiếp từ Firestore thay vì dựa vào pendingShipOrders state
    try {
      const shipQuery = query(
        collection(db, 'shipping_orders'),
        where('type', '==', 'ship'),
        where('status', 'in', ['pending', 'pending_qc'])
      );
      const shipSnap = await getDocs(shipQuery);
      for (const shipDoc of shipSnap.docs) {
        const shipData = shipDoc.data() as ShippingOrder;
        const matchedItemIdx = shipData.items?.findIndex(item =>
          item.moduleCode?.toLowerCase() === moduleCode.toLowerCase()
        );
        if (matchedItemIdx === undefined || matchedItemIdx === -1) continue;

        const matchedItem = shipData.items[matchedItemIdx];
        const currentChecked = matchedItem.checkedQty || 0;
        const remaining = matchedItem.quantity - currentChecked;
        if (remaining <= 0) continue;

        const qtyToSync = Math.min(qtyToAdd, remaining);
        let nextScannedIds = [...(matchedItem.scannedInstanceIds || [])];
        if (scannedInstanceId) {
          nextScannedIds = Array.from(new Set([...nextScannedIds, scannedInstanceId]));
        }

        const updatedShipItems = shipData.items.map((item, idx) => {
          if (idx === matchedItemIdx) {
            return { ...item, checkedQty: currentChecked + qtyToSync, scannedInstanceIds: nextScannedIds };
          }
          return item;
        });
        const isAllCompleted = updatedShipItems.every(item => (item.checkedQty || 0) >= item.quantity);
        await updateDoc(doc(db, 'shipping_orders', shipDoc.id), {
          items: updatedShipItems,
          status: isAllCompleted ? 'completed' : 'pending'
        });
      }
    } catch (e) {
      console.error('Lỗi đồng bộ phiếu giao:', e);
    }

    // Dong bo vao du an: cap nhat receivedQuantity va instance (giống thêm thủ công)
    if (matchedEntry.id && matchedEntry.projectCode) {
      const configId = matchedEntry.configId || await findProjectConfigId(matchedEntry.projectCode);
      if (configId) {
        const entrySnap = await getDoc(doc(db, 'projectConfigs', configId, 'modules', matchedEntry.id));
        if (entrySnap.exists()) {
          const entryData = entrySnap.data() as ProjectEntry;
          const currentInstances = getModuleInstances(entryData);
          const displayLabel = userProfile?.ten_that || user?.displayName || user?.email || 'Unknown';
          const newDeliveryLog = {
            type: 'receive' as const,
            date: new Date(),
            by: displayLabel,
            notes: `Nhận từ phiếu nhận #${activeOrder.sequenceNumber}`
          };

          let updatedInstances = [...currentInstances];
          let nextReceived = entryData.receivedQuantity || 0;

          if (scannedInstanceId) {
            updatedInstances = currentInstances.map(inst => {
              if (inst.instanceId === scannedInstanceId || inst.id === scannedInstanceId) {
                if (!inst.delivered) nextReceived += 1;
                return { ...inst, delivered: true, deliveryLogs: [...(inst.deliveryLogs || []), newDeliveryLog] };
              }
              return inst;
            });

            // Nếu scannedInstanceId không khớp instance nào (dữ liệu stale), fallback: đánh dấu idle instance tiếp theo
            const anyUpdated = updatedInstances.some((inst, i) =>
              inst.delivered && inst.delivered !== currentInstances[i].delivered
            );
            if (!anyUpdated) {
              const idleIdx = currentInstances.findIndex(inst => !inst.delivered);
              if (idleIdx !== -1) {
                updatedInstances = currentInstances.map((inst, i) => {
                  if (i === idleIdx) {
                    nextReceived += 1;
                    return { ...inst, delivered: true, deliveryLogs: [...(inst.deliveryLogs || []), newDeliveryLog] };
                  }
                  return inst;
                });
              }
            }
          } else {
            nextReceived += qtyToAdd;
            updatedInstances = currentInstances.map(inst => {
              if (!inst.delivered) {
                return { ...inst, delivered: true, deliveryLogs: [...(inst.deliveryLogs || []), newDeliveryLog] };
              }
              return inst;
            });
          }

          const isFullyReceived = nextReceived >= entryData.quantity;
          const newStatus = isFullyReceived ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận';
          const history = [...(entryData.statusHistory || [])];
          if (!history.length || history[history.length - 1].split('|')[0] !== newStatus) {
            history.push(`${newStatus}|${Date.now()}`);
          }

          await updateProjectModule(matchedEntry.id, {
            instances: updatedInstances,
            receivedQuantity: nextReceived,
            status: newStatus,
            statusHistory: history
          }, matchedEntry.projectCode);
        }
      }
    }

    showSuccess(`Đã thêm "${moduleCode}" (x${qtyToAdd}) vào phiếu nhận & đồng bộ phiếu giao + dự án!`);
  };

  // Get modules that are not yet fully received/shipped for a specific project
  const getAvailableModules = (projectCode: string) => {
    return projectEntries.filter(p => {
      if (p.projectCode !== projectCode) return false;
      const stagedQty = stagedItems.filter(item => item.id === p.id).reduce((sum, item) => sum + (item.quantity || 0), 0);
      const totalDelivered = p.receivedQuantity || 0;
      const remainingQty = p.quantity - totalDelivered - stagedQty;

      if (remainingQty <= 0) return false;

      return true;
    }).sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
  };

  const getFilteredAvailableModules = () => {
    if (!manualAddProject) return [];
    const allAvailables = getAvailableModules(manualAddProject);

    let list: ProjectEntry[] = [];
    if (manualAddMode === 'thung') {
      list = projectEntries.filter(p => {
        if (p.projectCode !== manualAddProject) return false;
        if (getEntryType(p) !== 'Thùng') return false;

        const isSelfAvailable = allAvailables.some(m => m.id === p.id);
        const hasAvailableDotChild = allAvailables.some(child => {
          if (getEntryType(child) !== 'Đợt') return false;
          const parentCandidate = getParentCodeCandidate(child.moduleCode || '').toLowerCase();
          return parentCandidate === (p.moduleCode || '').toLowerCase();
        });

        return isSelfAvailable || hasAvailableDotChild;
      });
    } else if (manualAddMode === 'hang_son') {
      list = projectEntries.filter(p => {
        if (p.projectCode !== manualAddProject) return false;
        if (getEntryType(p) !== 'Thùng') return false;

        const hasAvailableHangSonChild = allAvailables.some(child => {
          const type = getEntryType(child);
          const isHangSon = type === 'Cánh' || type === 'Mặt HK' || type === 'CTHT';
          if (!isHangSon) return false;

          const parentCandidate = getParentCodeCandidate(child.moduleCode || '').toLowerCase();
          return parentCandidate === (p.moduleCode || '').toLowerCase();
        });

        return hasAvailableHangSonChild;
      });
    } else {
      list = allAvailables;
    }

    if (manualSearchQuery.trim()) {
      let q = manualSearchQuery.trim();
      if (q.includes("----")) {
        q = q.split("----")[0].trim();
      }
      list = list.filter(item =>
        matchSearchQuery(item.moduleCode || '', q) ||
        matchSearchQuery(item.classification || getEntryType(item) || '', q) ||
        matchSearchQuery(item.cluster || '', q)
      );
    }

    return list;
  };

  const handleAddManualItem = (selectedModule: ProjectEntry) => {
    const availables = getAvailableModules(manualAddProject);

    // Helper: kiểm tra instance-level QC White — trả về số instance đã pass và chưa giao
    const getShipableWhitePassedInstances = (mod: ProjectEntry): number => {
      const insts = getModuleInstances(mod);
      return insts.filter(inst => (inst as any).qcWhite?.status === 'pass' && !inst.delivered).length;
    };

    if (manualAddMode === 'thung') {
      const isSelfAvailable = availables.some(m => m.id === selectedModule.id);
      if (isSelfAvailable) {
        // Kiểm tra QC Hàng Trắng instance-level khi giao hàng
        if (activeTab === 'ship') {
          const shipable = getShipableWhitePassedInstances(selectedModule);
          if (shipable <= 0) {
            showWarning(`Cấu kiện "${selectedModule.moduleCode}" không có instance nào đạt QC Hàng Trắng để giao.`);
            return;
          }
        }
        addItemToStage({
          id: selectedModule.id,
          moduleCode: selectedModule.moduleCode,
          name: selectedModule.moduleCode,
          quantity: 1,
          totalQty: selectedModule.quantity,
          previouslyDeliveredQty: selectedModule.receivedQuantity || 0,
          width: selectedModule.pWidth || selectedModule.width || 0,
          depth: selectedModule.pDepth || selectedModule.depth || 0,
          height: selectedModule.pHeight || selectedModule.height || 0,
          cluster: selectedModule.cluster,
          projectCode: selectedModule.projectCode,
          projectName: selectedModule.projectName,
          subType: 'kienModule',
          unit: 'cái'
        });
      }

      const dotChildren = availables.filter(child => {
        if (getEntryType(child) !== 'Đợt') return false;
        const parentCandidate = getParentCodeCandidate(child.moduleCode || '').toLowerCase();
        return parentCandidate === (selectedModule.moduleCode || '').toLowerCase();
      });

      dotChildren.forEach(child => {
        // Kiểm tra QC Hàng Trắng instance-level khi giao hàng
        if (activeTab === 'ship') {
          const shipable = getShipableWhitePassedInstances(child);
          if (shipable <= 0) {
            showWarning(`Cấu kiện "${child.moduleCode}" không có instance nào đạt QC Hàng Trắng để giao.`);
            return;
          }
        }
        addItemToStage({
          id: child.id,
          moduleCode: child.moduleCode,
          name: child.moduleCode,
          quantity: 1,
          totalQty: child.quantity,
          previouslyDeliveredQty: child.receivedQuantity || 0,
          width: child.pWidth || child.width || 0,
          depth: child.pDepth || child.depth || 0,
          height: child.pHeight || child.height || 0,
          cluster: child.cluster,
          projectCode: child.projectCode,
          projectName: child.projectName,
          subType: 'kienModule',
          unit: 'cái'
        });
      });

    } else if (manualAddMode === 'hang_son') {
      const hangSonChildren = availables.filter(child => {
        const type = getEntryType(child);
        const isHangSon = type === 'Cánh' || type === 'Mặt HK' || type === 'CTHT';
        if (!isHangSon) return false;

        const parentCandidate = getParentCodeCandidate(child.moduleCode || '').toLowerCase();
        return parentCandidate === (selectedModule.moduleCode || '').toLowerCase();
      });

      if (hangSonChildren.length === 0) {
        alert(`Thùng "${selectedModule.moduleCode}" không có chi tiết hàng sơn con nào chưa giao đủ.`);
        return;
      }

      hangSonChildren.forEach(child => {
        const remaining = (child.quantity || 0) - (child.receivedQuantity || 0);
        if (remaining <= 0) return;
        // Kiểm tra QC Hàng Trắng instance-level khi giao hàng
        if (activeTab === 'ship') {
          const shipable = getShipableWhitePassedInstances(child);
          if (shipable <= 0) {
            showWarning(`Cấu kiện "${child.moduleCode}" không có instance nào đạt QC Hàng Trắng để giao.`);
            return;
          }
        }
        addItemToStage({
          id: child.id,
          moduleCode: child.moduleCode,
          name: child.moduleCode,
          quantity: remaining,
          totalQty: child.quantity,
          previouslyDeliveredQty: child.receivedQuantity || 0,
          width: child.pWidth || child.width || 0,
          depth: child.pDepth || child.depth || 0,
          height: child.pHeight || child.height || 0,
          cluster: child.cluster,
          projectCode: child.projectCode,
          projectName: child.projectName,
          subType: 'kienPhuKien',
          unit: 'cái'
        });
      });
    } else {
      // Kiểm tra QC Hàng Trắng instance-level khi giao hàng
      if (activeTab === 'ship') {
        const shipable = getShipableWhitePassedInstances(selectedModule);
        if (shipable <= 0) {
          showWarning(`Cấu kiện "${selectedModule.moduleCode}" không có instance nào đạt QC Hàng Trắng để giao.`);
          return;
        }
      }
      addItemToStage({
        id: selectedModule.id,
        moduleCode: selectedModule.moduleCode,
        name: selectedModule.moduleCode,
        quantity: 1,
        totalQty: selectedModule.quantity,
        previouslyDeliveredQty: selectedModule.receivedQuantity || 0,
        width: selectedModule.pWidth || selectedModule.width || 0,
        depth: selectedModule.pDepth || selectedModule.depth || 0,
        height: selectedModule.pHeight || selectedModule.height || 0,
        cluster: selectedModule.cluster,
        projectCode: selectedModule.projectCode,
        projectName: selectedModule.projectName,
        subType: (selectedModule.pWidth || selectedModule.pDepth || selectedModule.pHeight || selectedModule.width || selectedModule.depth || selectedModule.height) ? 'kienModule' : 'kienPhuKien',
        unit: 'cái'
      });
    }
  };

  const sortStagedItems = (list: ShippingOrderItem[]) => {
    return [...list].sort((a, b) => {
      const scoreA = (a.isOverReceived || a.isUnassigned || !a.id) ? 1 : 0;
      const scoreB = (b.isOverReceived || b.isUnassigned || !b.id) ? 1 : 0;
      if (scoreA !== scoreB) {
        return scoreA - scoreB; // 0 (bình thường) lên trước, 1 (nhận dư/phát sinh) xuống cuối
      }
      if (a.projectCode !== b.projectCode) {
        return (a.projectCode || '').localeCompare(b.projectCode || '');
      }
      const entryA = resolveModule(a.id, a.projectCode);
      const entryB = resolveModule(b.id, b.projectCode);
      return (entryA?.sortIndex || 0) - (entryB?.sortIndex || 0);
    });
  };

  const addItemToStage = (item: ShippingOrderItem) => {
    setStagedItems(prev => {
      // Tìm dòng trùng lặp dựa trên: cùng id/mã, cùng trạng thái nhận dư, cùng trạng thái phát sinh
      const existingIdx = prev.findIndex(i => {
        const idMatch = (item.id && i.id && i.id === item.id) ||
          (!item.id && !i.id && i.moduleCode?.toLowerCase() === item.moduleCode?.toLowerCase() && i.projectCode === item.projectCode);
        const overReceivedMatch = !!i.isOverReceived === !!item.isOverReceived;
        const unassignedMatch = !!i.isUnassigned === !!item.isUnassigned;
        return idMatch && overReceivedMatch && unassignedMatch;
      });

      if (existingIdx >= 0) {
        const next = [...prev];
        const prevInstances = next[existingIdx].scannedInstanceIds || [];
        const newInstances = item.scannedInstanceIds || [];
        const mergedInstances = Array.from(new Set([...prevInstances, ...newInstances]));

        next[existingIdx] = {
          ...next[existingIdx],
          quantity: next[existingIdx].quantity + (item.quantity || 1),
          scannedInstanceIds: mergedInstances
        };
        return sortStagedItems(next);
      }

      const newList = [...prev, item];
      return sortStagedItems(newList);
    });
  };

  const removeStagedItem = (index: number) => {
    setStagedItems(prev => prev.filter((_, i) => i !== index));
  };

  const updateStagedItemQuantity = (index: number, qty: number) => {
    setStagedItems(prev => {
      const next = [...prev];
      const item = next[index];

      if (item.id && !item.isOverReceived && !item.isUnassigned) {
        const entry = resolveModule(item.id, item.projectCode);
        if (entry) {
          const totalDelivered = entry.receivedQuantity || 0;
          const maxAllowed = entry.quantity - totalDelivered;

          if (qty > maxAllowed) {
            if (activeTab === 'receive') {
              alert(`Số lượng bình thường tối đa có thể chọn là ${maxAllowed}. Các số lượng vượt định mức sẽ tự động được ghi nhận dạng Nhận dư khi quét QR.`);
            } else {
              alert(`Số lượng tối đa có thể chọn cho module này là ${maxAllowed}.`);
            }
            next[index] = { ...item, quantity: Math.max(1, maxAllowed) };
            return next;
          }
        }
      }

      next[index] = { ...item, quantity: Math.max(1, qty) };
      return next;
    });
  };

  const getMatchedEntryDelivery = (res: ScannedResult) => {
    if (!res) return null;
    let rawText = (res.rawCode || res.moduleCode || '').trim();
    if (!rawText) return null;

    // Nếu chứa dấu | (ví dụ Cánh tủ|1), chúng ta lấy phần trước dấu |
    if (rawText.includes('|')) {
      rawText = rawText.split('|')[0].trim();
    }

    // Tách bỏ bộ đếm số lượng dạng "-X/Y" (ví dụ: CFS026_COTE.T1-1/3 thành CFS026_COTE.T1)
    let cleanCode = rawText;
    const suffixRegex = /-(\d+)\/(\d+)$/;
    if (suffixRegex.test(cleanCode)) {
      cleanCode = cleanCode.replace(suffixRegex, '').trim();
    }

    // Bước 1: 20.ELMB1_Cánh phải_KIT.T2 -> ELMB1_Cánh phải_KIT.T2 (Bỏ phần số định danh <số>.)
    const step1Code = cleanCode.replace(/^\d+\./, '').trim();
    let entry = projectEntries.find(e => (e.moduleCode || '').toLowerCase() === step1Code.toLowerCase()) || null;

    // Bước 2: Nếu ELMB1_Cánh phải_KIT.T2 không tìm thấy sẽ đổi -> ELMB1_KIT.T2 (Tách và ghép đầu - cuối)
    if (!entry) {
      const parts = step1Code.split('_');
      if (parts.length >= 2) {
        const step2Code = `${parts[0]}_${parts[parts.length - 1]}`;
        entry = projectEntries.find(e => (e.moduleCode || '').toLowerCase() === step2Code.toLowerCase()) || null;
      }
    }

    // Bước 3: Tìm chính xác theo mã thô đã gột sạch đếm nếu chưa khớp ở trên
    if (!entry) {
      entry = projectEntries.find(e => (e.moduleCode || '').toLowerCase() === cleanCode.toLowerCase()) || null;
    }

    return entry;
  };

  const onScanConfirm = (result: ScannedResult) => {
    // Capture scan data for auto-sync to pending ship orders
    let _syncModuleCode: string | undefined;
    let _syncQty: number = 0;
    let _syncInstanceIds: string[] | undefined;

    let entry = resolveModule(result.matchedId || '', result.projectCode);
    // Nếu có instanceId trong QR, tìm entry phù hợp và truyền instanceId
    if (!entry && result.instanceId) {
      const possible = resolveModule(result.parsedModuleId || '', result.projectCode);
      if (possible) {
        entry = possible;
      }
    }
    // Fallback: existing logic
    if (!entry) {
      // existing matching logic (unchanged) ...
    }

    // Fallback: search using our robust QR conversion logic if no ID match (highly synchronized with menu scanner)
    if (!entry) {
      entry = getMatchedEntryDelivery(result);
    }

    // Determine quantity to add: if scanConfirmQty is empty or invalid, default to 1
    let qtyToReceiveValue = typeof scanConfirmQty === 'number' ? scanConfirmQty : 1;
    if (qtyToReceiveValue <= 0) {
      alert("Số lượng nhận phải lớn hơn 0!");
      return;
    }

    if (entry && entry.moduleType === 'bo') {
      const currentProcessed = activeTab === 'receive' ? (entry.receivedQuantity || 0) : (entry.shippedQuantity || 0);
      const stagedQty = stagedItems
        .filter(item => item.id === entry!.id && !item.isOverReceived)
        .reduce((sum, item) => sum + (item.quantity || 0), 0);
      const remainingToProcess = entry.quantity - currentProcessed - stagedQty;

      if (remainingToProcess <= 0) {
        alert("Bộ này đã được xử lý đầy đủ số lượng!");
        setScannedResult(null);
        return;
      }

      // Hỏi trực tiếp số lượng cấu kiện nhận của bộ này
      const userPrompt = prompt(`Phát hiện Module "${entry.moduleCode}" thuộc kiểu "bộ". Vui lòng nhập số lượng cấu kiện nhận thực tế cho bộ này (Tối đa còn lại: ${remainingToProcess}):`, String(remainingToProcess));
      if (userPrompt === null) {
        setScannedResult(null);
        return;
      }

      let boQty = parseInt(userPrompt, 10);
      if (isNaN(boQty) || boQty <= 0) {
        alert("Số lượng cấu kiện nhập không hợp lệ!");
        setScannedResult(null);
        return;
      }

      if (boQty > remainingToProcess) {
        alert(`Số lượng nhập vượt quá giới hạn còn lại. Tự động thiết lập về tối đa ${remainingToProcess}.`);
        boQty = remainingToProcess;
      }

      addItemToStage({
        id: entry.id,
        moduleCode: entry.moduleCode,
        name: entry.moduleCode,
        quantity: boQty,
        totalQty: entry.quantity,
        previouslyDeliveredQty: currentProcessed,
        width: entry.pWidth || entry.width || 0,
        depth: entry.pDepth || entry.depth || 0,
        height: entry.pHeight || entry.height || 0,
        cluster: entry.cluster,
        projectCode: entry.projectCode,
        projectName: entry.projectName,
        subType: 'kienPhuKien',
        unit: entry.unit || 'bộ'
      });
      setScannedResult(null);
      return;
    }

    const qtyToReceive = qtyToReceiveValue;

    if (entry) {
      // Xác định scannedInstanceId trước để check instance-level QC
      let cleanResultCode = result.moduleCode;
      if (cleanResultCode.includes('|')) {
        cleanResultCode = cleanResultCode.split('|')[0].trim();
      }

      let scannedInstanceId = result.instanceId;
      if (!scannedInstanceId) {
        scannedInstanceId = result.rawCode && result.rawCode.includes('|') ? result.rawCode.trim() : undefined;
      }
      const entryInsts = getModuleInstances(entry);
      if (!scannedInstanceId) {
        const idleInst = entryInsts.find(inst => !inst.delivered);
        if (idleInst) {
          scannedInstanceId = idleInst.instanceId || idleInst.id;
        } else {
          scannedInstanceId = entryInsts[0]?.instanceId || entryInsts[0]?.id || `${entry.moduleCode}|1`;
        }
      }

      // Kiểm tra QC Hàng Trắng theo instance khi giao hàng
      if (activeTab === 'ship') {
        const targetInst = entryInsts.find(inst => inst.instanceId === scannedInstanceId || inst.id === scannedInstanceId);
        const qcWhiteStatus = (targetInst as any)?.qcWhite?.status;
        if (qcWhiteStatus !== 'pass') {
          showWarning(`Instance "${scannedInstanceId}" của cấu kiện "${entry.moduleCode}" chưa đạt QC Hàng Trắng (trạng thái: ${qcWhiteStatus || 'chưa kiểm'}). Vui lòng kiểm tra Hàng Trắng trước khi giao.`);
          setScannedResult(null);
          return;
        }
      }

      const totalDelivered = entry.receivedQuantity || 0;
      const stagedQty = stagedItems
        .filter(item => (item.id === entry!.id && !item.isOverReceived))
        .reduce((sum, item) => sum + (item.quantity || 0), 0);
      const remainingQty = entry.quantity - totalDelivered - stagedQty;

      if (activeTab === 'receive') {
        // LUỒNG NHẬN HÀNG: Cho phép nhận dư để đối chiếu
        if (remainingQty <= 0) {
          addItemToStage({
            id: entry.id,
            moduleCode: result.moduleCode,
            name: result.moduleCode,
            quantity: qtyToReceive,
            totalQty: entry.quantity,
            previouslyDeliveredQty: totalDelivered,
            width: result.width || entry.pWidth || entry.width || 0,
            depth: result.depth || entry.pDepth || entry.depth || 0,
            height: result.height || entry.pHeight || entry.height || 0,
            cluster: entry.cluster,
            projectCode: entry.projectCode,
            projectName: entry.projectName,
            subType: 'kienPhuKien',
            unit: 'cái',
            notes: 'Nhận dư (Đã đủ số quy định)',
            isOverReceived: true,
            scannedInstanceIds: scannedInstanceId ? [scannedInstanceId] : []
          });
          _syncModuleCode = result.moduleCode;
          _syncQty = qtyToReceive;
          _syncInstanceIds = scannedInstanceId ? [scannedInstanceId] : [];
        } else {
          if (qtyToReceive <= remainingQty) {
            addItemToStage({
              id: entry.id,
              moduleCode: result.moduleCode,
              name: result.moduleCode,
              quantity: qtyToReceive,
              totalQty: entry.quantity,
              previouslyDeliveredQty: totalDelivered,
              width: result.width || entry.pWidth || entry.width || 0,
              depth: result.depth || entry.pDepth || entry.depth || 0,
              height: result.height || entry.pHeight || entry.height || 0,
              cluster: entry.cluster,
              projectCode: entry.projectCode,
              projectName: entry.projectName,
              subType: 'kienPhuKien',
              unit: 'cái',
              scannedInstanceIds: scannedInstanceId ? [scannedInstanceId] : []
            });
            _syncModuleCode = result.moduleCode;
            _syncQty = qtyToReceive;
            _syncInstanceIds = scannedInstanceId ? [scannedInstanceId] : [];
          } else {
            // Tách thành 2 dòng: Bình thường và Nhận dư
            addItemToStage({
              id: entry.id,
              moduleCode: result.moduleCode,
              name: result.moduleCode,
              quantity: remainingQty,
              totalQty: entry.quantity,
              previouslyDeliveredQty: totalDelivered,
              width: result.width || entry.pWidth || entry.width || 0,
              depth: result.depth || entry.pDepth || entry.depth || 0,
              height: result.height || entry.pHeight || entry.height || 0,
              cluster: entry.cluster,
              projectCode: entry.projectCode,
              projectName: entry.projectName,
              subType: 'kienPhuKien',
              unit: 'cái',
              scannedInstanceIds: scannedInstanceId ? [scannedInstanceId] : []
            });

            addItemToStage({
              id: entry.id,
              moduleCode: result.moduleCode,
              name: result.moduleCode,
              quantity: qtyToReceive - remainingQty,
              totalQty: entry.quantity,
              previouslyDeliveredQty: totalDelivered + remainingQty,
              width: result.width || entry.pWidth || entry.width || 0,
              depth: result.depth || entry.pDepth || entry.depth || 0,
              height: result.height || entry.pHeight || entry.height || 0,
              cluster: entry.cluster,
              projectCode: entry.projectCode,
              projectName: entry.projectName,
              subType: 'kienPhuKien',
              unit: 'cái',
              notes: 'Nhận dư (Vượt định mức)',
              isOverReceived: true,
              scannedInstanceIds: []
            });
            _syncModuleCode = result.moduleCode;
            _syncQty = qtyToReceive;
            _syncInstanceIds = scannedInstanceId ? [scannedInstanceId] : [];
          }
        }
      } else {
        // LUỒNG GIAO HÀNG (ship)
        if (remainingQty <= 0) {
          alert("Đã giao đủ Module này");
          setScannedResult(null);
          return;
        }

        let finalQty = qtyToReceive;
        if (finalQty > remainingQty) {
          alert(`Số lượng còn lại tối đa có thể ghi nhận là ${remainingQty}. Đã tự động điều chỉnh về ${remainingQty}.`);
          finalQty = remainingQty;
        }

        addItemToStage({
          id: entry.id,
          moduleCode: result.moduleCode,
          name: result.moduleCode,
          quantity: finalQty,
          totalQty: entry.quantity,
          previouslyDeliveredQty: (entry.receivedQuantity || 0),
          width: result.width || entry.pWidth || entry.width || 0,
          depth: result.depth || entry.pDepth || entry.depth || 0,
          height: result.height || entry.pHeight || entry.height || 0,
          cluster: entry.cluster,
          projectCode: entry.projectCode,
          projectName: entry.projectName,
          subType: 'kienPhuKien',
          unit: 'cái',
          scannedInstanceIds: scannedInstanceId ? [scannedInstanceId] : []
        });
      }
    } else {
      // KHÔNG CÓ TRONG DỰ ÁN => PHÁT SINH
      if (activeTab === 'ship') {
        alert("Không thể giao module phát sinh chưa có trong hệ thống dự án.");
        setScannedResult(null);
        return;
      }

      const activeProjectCode = manualAddProject || (stagedItems.length > 0 ? stagedItems[0].projectCode : '');
      const activeProjectName = projectEntries.find(p => p.projectCode === activeProjectCode)?.projectName || activeProjectCode;

      addItemToStage({
        name: result.moduleCode,
        moduleCode: result.moduleCode,
        quantity: qtyToReceive,
        width: result.width || 0,
        depth: result.depth || 0,
        height: result.height || 0,
        unit: 'cái',
        projectCode: activeProjectCode || 'UNASSIGNED',
        projectName: activeProjectName || 'Dự án phát sinh',
        isUnassigned: true,
        notes: 'Phát sinh ngoài danh mục'
      });
    }

    // Auto-sync checkedQty to pending ship orders for receive flow
    if (activeTab === 'receive' && _syncModuleCode && _syncQty > 0) {
      syncCheckedQtyToShipOrders(_syncModuleCode, _syncQty, _syncInstanceIds);
    }
    setScannedResult(null);
  };

  // Handler cho việc thêm cấu kiện vào phiếu đã tồn tại (khi đang xem chi tiết phiếu)
  const handleAddToExistingOrder = async (result: ScannedResult, qtyOverride?: number) => {
    if (!activeOrder || !user) return;

    let entry = resolveModule(result.matchedId || '', result.projectCode);
    if (!entry && result.instanceId) {
      const possible = resolveModule(result.parsedModuleId || '', result.projectCode);
      if (possible) entry = possible;
    }
    if (!entry) {
      entry = getMatchedEntryDelivery(result);
    }

    const qtyToAdd = qtyOverride ?? 1;

    // Xác định scannedInstanceId — LUÔN verify từ fresh Firestore
    let scannedInstanceId = result.instanceId;
    if (!scannedInstanceId) {
      scannedInstanceId = result.rawCode && result.rawCode.includes('|') ? result.rawCode.trim() : undefined;
    }
    if (entry?.id && entry?.projectCode) {
      try {
        const freshConfigId = entry.configId || await findProjectConfigId(entry.projectCode);
        if (freshConfigId) {
          const freshSnap = await getDoc(doc(db, 'projectConfigs', freshConfigId, 'modules', entry.id));
          if (freshSnap.exists()) {
            const freshInstances = getModuleInstances(freshSnap.data() as ProjectEntry);
            if (scannedInstanceId) {
              const matchedInst = freshInstances.find(inst => inst.instanceId === scannedInstanceId || inst.id === scannedInstanceId);
              if (matchedInst && !matchedInst.delivered) {
                // Instance từ QR vẫn idle → giữ nguyên
              } else {
                const idleInst = freshInstances.find(inst => !inst.delivered);
                scannedInstanceId = idleInst ? (idleInst.instanceId || idleInst.id) : (freshInstances[0]?.instanceId || freshInstances[0]?.id || `${result.moduleCode}|1`);
              }
            } else {
              const idleInst = freshInstances.find(inst => !inst.delivered);
              scannedInstanceId = idleInst ? (idleInst.instanceId || idleInst.id) : (freshInstances[0]?.instanceId || freshInstances[0]?.id || `${result.moduleCode}|1`);
            }
          }
        }
      } catch (e) {
        // Fallback: dùng stale data
        if (!scannedInstanceId && entry) {
          const entryInsts = getModuleInstances(entry);
          const idleInst = entryInsts.find(inst => !inst.delivered);
          scannedInstanceId = idleInst ? (idleInst.instanceId || idleInst.id) : (entryInsts[0]?.instanceId || entryInsts[0]?.id || `${result.moduleCode}|1`);
        }
      }
    } else if (!scannedInstanceId && entry) {
      const entryInsts = getModuleInstances(entry);
      const idleInst = entryInsts.find(inst => !inst.delivered);
      if (idleInst) {
        scannedInstanceId = idleInst.instanceId || idleInst.id;
      } else {
        scannedInstanceId = entryInsts[0]?.instanceId || entryInsts[0]?.id || `${result.moduleCode}|1`;
      }
    }

    // Kiểm tra QC Hàng Trắng instance-level khi thêm vào phiếu giao
    if (activeOrder.type === 'ship' && entry && scannedInstanceId) {
      const checkInsts = getModuleInstances(entry);
      const targetInst = checkInsts.find(inst => inst.instanceId === scannedInstanceId || inst.id === scannedInstanceId);
      const qcWhiteStatus = (targetInst as any)?.qcWhite?.status;
      if (qcWhiteStatus !== 'pass') {
        showWarning(`Instance "${scannedInstanceId}" của "${entry.moduleCode}" chưa đạt QC Hàng Trắng (trạng thái: ${qcWhiteStatus || 'chưa kiểm'}). Không thể thêm vào phiếu giao.`);
        return;
      }
    }

    const currentItems = activeOrder.items || [];
    const targetModuleCode = (entry?.moduleCode || result.moduleCode || '').toLowerCase();

    // Xác định syncStatus cho phiếu nhận
    const syncStatus: 'synced' | 'unmatched' | undefined = activeOrder.type === 'receive' ? (
      pendingShipOrders.some(order =>
        order.items?.some(item =>
          (item.moduleCode || '').toLowerCase() === targetModuleCode
          && (item.checkedQty || 0) < item.quantity
        )
      ) ? 'synced' : 'unmatched'
    ) : undefined;

    // Kiểm tra item cùng moduleCode đã có trong phiếu chưa → gộp instance
    const existingIdx = currentItems.findIndex(
      item => (item.moduleCode || '').toLowerCase() === targetModuleCode
    );

    let updatedItems;
    if (existingIdx >= 0) {
      updatedItems = currentItems.map((item, idx) => {
        if (idx === existingIdx) {
          const mergedIds = Array.from(new Set([...(item.scannedInstanceIds || []), ...(scannedInstanceId ? [scannedInstanceId] : [])]));
          return { ...item, quantity: (item.quantity || 0) + qtyToAdd, scannedInstanceIds: mergedIds, syncStatus: syncStatus || item.syncStatus };
        }
        return item;
      });
    } else {
      const newItem: ShippingOrderItem = {
        id: entry?.id || '',
        moduleCode: entry?.moduleCode || result.moduleCode,
        name: entry?.moduleCode || result.moduleCode,
        quantity: qtyToAdd,
        width: result.width || entry?.pWidth || entry?.width || 0,
        depth: result.depth || entry?.pDepth || entry?.depth || 0,
        height: result.height || entry?.pHeight || entry?.height || 0,
        cluster: entry?.cluster || '',
        projectCode: entry?.projectCode || activeOrder.projectCode,
        projectName: entry?.projectName || activeOrder.projectName || '',
        scannedInstanceIds: scannedInstanceId ? [scannedInstanceId] : [],
        syncStatus
      };
      updatedItems = [newItem, ...currentItems];
    }

    try {
      setLoading(true);
      const updateData: Record<string, any> = { items: updatedItems };

      // Tự động cập nhật tên dự án vào phiếu giao nếu có entry mới
      if (entry?.projectCode && (!activeOrder.projectCode || activeOrder.projectCode === 'UNASSIGNED' || activeOrder.projectCode === 'MULTI')) {
        updateData.projectCode = entry.projectCode;
        updateData.projectName = entry.projectName || entry.projectCode;
      }

      await updateDoc(doc(db, 'shipping_orders', activeOrder.id), cleanUndefinedFields(updateData));

      // Với phiếu giao: nếu tiến độ không còn 100% → tự chuyển sang chờ kiểm hàng
      if (activeOrder.type === 'ship') {
        const newTotal = updatedItems.reduce((sum, i) => sum + (i.quantity || 0), 0);
        const newChecked = updatedItems.reduce((sum, i) => sum + (i.checkedQty || 0), 0);
        if (newTotal > 0 && newChecked < newTotal && (activeOrder.status as string) !== 'pending_qc') {
          await updateDoc(doc(db, 'shipping_orders', activeOrder.id), {
            status: 'pending_qc',
            note: 'Tự chuyển chờ kiểm hàng khi thêm kiện mới'
          });
        }
      }

      // Với phiếu nhận: đồng bộ checkedQty về phiếu giao tương ứng
      if (activeOrder.type === 'receive' && qtyToAdd > 0 && scannedInstanceId) {
        syncCheckedQtyToShipOrders(
          entry?.moduleCode || result.moduleCode,
          qtyToAdd,
          [scannedInstanceId]
        );
      }

      // Đồng bộ vào dự án: cập nhật receivedQuantity và delivered instance (luôn chạy cho phiếu nhận)
      if (activeOrder.type === 'receive' && entry?.id && entry?.projectCode) {
        try {
          const configId = entry.configId || await findProjectConfigId(entry.projectCode);
            if (configId) {
              const entrySnap = await getDoc(doc(db, 'projectConfigs', configId, 'modules', entry.id));
              if (entrySnap.exists()) {
                const entryData = entrySnap.data() as ProjectEntry;
                const currentInstances = getModuleInstances(entryData);
                const displayLabel = userProfile?.ten_that || user?.displayName || user?.email || 'Unknown';
                const newDeliveryLog = {
                  type: 'receive' as const,
                  date: new Date(),
                  by: displayLabel,
                  notes: `Nhận từ phiếu nhận (thủ công)`
                };

                let updatedInstances = [...currentInstances];
                let nextReceived = entryData.receivedQuantity || 0;

                updatedInstances = currentInstances.map(inst => {
                  if (inst.instanceId === scannedInstanceId || inst.id === scannedInstanceId) {
                    if (!inst.delivered) nextReceived += 1;
                    return { ...inst, delivered: true, deliveryLogs: [...(inst.deliveryLogs || []), newDeliveryLog] };
                  }
                  return inst;
                });

                // Nếu scannedInstanceId không khớp instance nào (dữ liệu stale), fallback: đánh dấu idle instance tiếp theo
                const anyUpdated = updatedInstances.some((inst, i) =>
                  inst.delivered && inst.delivered !== currentInstances[i].delivered
                );
                if (!anyUpdated) {
                  const idleIdx = currentInstances.findIndex(inst => !inst.delivered);
                  if (idleIdx !== -1) {
                    updatedInstances = currentInstances.map((inst, i) => {
                      if (i === idleIdx) {
                        nextReceived += 1;
                        return { ...inst, delivered: true, deliveryLogs: [...(inst.deliveryLogs || []), newDeliveryLog] };
                      }
                      return inst;
                    });
                  }
                }

                const isFullyReceived = nextReceived >= entryData.quantity;
                const newStatus = isFullyReceived ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận';
                const history = [...(entryData.statusHistory || [])];
                if (!history.length || history[history.length - 1].split('|')[0] !== newStatus) {
                  history.push(`${newStatus}|${Date.now()}`);
                }

                await updateProjectModule(entry.id, {
                  instances: updatedInstances,
                  receivedQuantity: nextReceived,
                  status: newStatus,
                  statusHistory: history
                }, entry.projectCode);
              }
            }
          } catch (e) {
            console.error('Lỗi đồng bộ receivedQuantity vào dự án:', e);
          }
      }

      showSuccess(`Đã thêm "${entry?.moduleCode || result.moduleCode}" (x${qtyToAdd}) vào phiếu!`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'shipping_orders');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!user || stagedItems.length === 0) return;
    setLoading(true);
    try {
      const batch = writeBatch(db);
      const type = activeTab;

      // Extract unique projects from staged items
      const uniqueProjects = Array.from(new Set(stagedItems.map(item => item.projectCode).filter(Boolean))) as string[];

      let targetProjectCode = 'MULTI';
      let targetProjectName = 'Nhiều dự án';

      if (uniqueProjects.length === 1) {
        targetProjectCode = uniqueProjects[0];
        targetProjectName = projectEntries.find(e => e.projectCode === targetProjectCode)?.projectName || targetProjectCode;
      } else if (uniqueProjects.length > 1) {
        targetProjectCode = 'MULTI';
        targetProjectName = `${uniqueProjects.join(', ')}`;
      } else {
        targetProjectCode = 'UNASSIGNED';
        targetProjectName = 'Phát sinh';
      }

      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');

      // Pre-process and create any missing child modules or spontaneous modules in Firestore if type is receive
      const updatedStagedItems = [...stagedItems];
      if (type === 'receive') {
        for (let i = 0; i < updatedStagedItems.length; i++) {
          const item = updatedStagedItems[i];
          if ((!item.id || item.isUnassigned) && item.moduleCode) {
            const parentCodeCandidate = getParentCodeCandidate(item.moduleCode || '').toLowerCase();
            const parentEntry = projectEntries.find(e =>
              e.projectCode === item.projectCode &&
              ((e.moduleCode || '').toLowerCase() === parentCodeCandidate || (item.parentModuleCode && (e.moduleCode || '').toLowerCase() === (item.parentModuleCode || '').toLowerCase()))
            );

            const newDocRef = doc(collection(db, 'projectConfigs', item.projectCode, 'modules'));
            const qty = item.quantity;

            // Khởi tạo instancesList cho module con mới sinh
            const instancesList = [];
            for (let k = 1; k <= qty; k++) {
              instancesList.push({
                id: `${item.moduleCode}|${k}`,
                instanceId: `${item.moduleCode}|${k}`,
                instanceIndex: k,
                tempLabelIndex: k,
                qcDone: false,
                delivered: true,
                qcLogs: [],
                deliveryLogs: [{
                  type: 'receive' as 'receive' | 'ship',
                  date: new Date(),
                  by: displayLabel,
                  notes: 'Nhận hàng đồng thời khi tạo module con'
                }]
              });
            }

            if (parentEntry) {
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
                ownerId: parentEntry.ownerId || user.uid,
                createdAt: new Date(),
                sortIndex: (parentEntry.sortIndex || 0) + 1,
                pWidth: item.width || 0,
                pDepth: item.depth || 0,
                pHeight: item.height || 0,
                width: item.width || 0,
                depth: item.depth || 0,
                height: item.height || 0,
                instances: instancesList,
                maxLabelIndex: qty
              };

              // Thêm mới bản ghi module con vào dự án
              batch.set(newDocRef, cleanUndefinedFields(newProjectEntry));

              // Gán id mới
              updatedStagedItems[i] = {
                ...item,
                id: newDocRef.id,
                isUnassigned: false,
                _justCreated: true
              };
            } else {
              // Trường hợp phát sinh hoàn toàn (không có parent)
              const newStatus = 'Giao Nhận - Đã nhận';
              const childType = getEntryType({ moduleCode: item.moduleCode } as any) || 'CTHT';

              const newProjectEntry: any = {
                projectName: item.projectName || 'Dự án phát sinh',
                projectCode: item.projectCode || 'UNASSIGNED',
                cluster: item.cluster || 'PHÁT SINH',
                moduleCode: item.moduleCode,
                quantity: qty, // vì phát sinh nên định mức cho bằng số lượng thực nhận luôn
                receivedQuantity: qty,
                shippedQuantity: 0,
                status: newStatus,
                statusHistory: [`${newStatus}|${Date.now()}`],
                classification: childType,
                ownerId: user.uid,
                createdAt: new Date(),
                sortIndex: 9999, // Đẩy xuống cuối dự án
                pWidth: item.width || 0,
                pDepth: item.depth || 0,
                pHeight: item.height || 0,
                width: item.width || 0,
                depth: item.depth || 0,
                height: item.height || 0,
                notes: item.notes || 'Phát sinh từ quét QR',
                instances: instancesList,
                maxLabelIndex: qty
              };

              batch.set(newDocRef, cleanUndefinedFields(newProjectEntry));
              updatedStagedItems[i] = {
                ...item,
                id: newDocRef.id,
                isUnassigned: false,
                _justCreated: true
              };
            }
          }
        }
      }

      // Calculate sequence number for the order code
      const q = query(
        collection(db, 'shipping_orders'),
        where('projectCode', '==', targetProjectCode),
        where('type', '==', type)
      );
      const snap = await getDocs(q);
      const sequenceNumber = snap.size + 1;

      // 1. Log Activity
      const logRef = doc(collection(db, 'activities'));
      batch.set(logRef, cleanUndefinedFields({
        userId: user.uid,
        userName: displayLabel,
        userEmail: user.email,
        action: type === 'receive' ? 'Nhận hàng' : 'Giao hàng',
        details: `${type === 'receive' ? 'Nhận' : 'Giao'} ${updatedStagedItems.reduce((sum, item) => sum + (item.quantity || 0), 0)} cấu kiện cho ${uniqueProjects.length > 1 ? `nhiều dự án (${uniqueProjects.join(', ')})` : `dự án ${targetProjectCode}`}${sequenceNumber > 1 ? ` (Lần ${sequenceNumber})` : ''}`,
        projectCode: targetProjectCode,
        timestamp: serverTimestamp()
      }));

      // 2. Create Order Record
      const recordRef = doc(collection(db, 'shipping_orders'));
      const defaultTitle = `${type === 'receive' ? 'Phiếu nhận' : 'Phiếu giao'} ${targetProjectCode === 'MULTI' ? 'Tổng hợp' : targetProjectCode} #${sequenceNumber}`;

      const preparedItems = type === 'ship'
        ? updatedStagedItems.map(item => ({ ...item, checkedQty: 0 }))
        : updatedStagedItems;

      const orderData: any = {
        type,
        title: customTitle || defaultTitle,
        projectCode: targetProjectCode,
        projectName: targetProjectName,
        sequenceNumber,
        items: preparedItems,
        createdAt: new Date(),
        createdBy: user.uid,
        userName: displayLabel
      };

      if (type === 'ship') {
        orderData.status = 'pending';

        // Tự động tạo thông báo nghiệp vụ cho các user có chức danh hoặc vai trò 'LR2 Leader'
        const notifyRef = doc(collection(db, 'notifications'));
        const notifyData = {
          title: 'Có phiếu giao nhận mới',
          content: `Có phiếu giao nhận mới cần xử lý: Phiếu giao ${targetProjectCode} #${sequenceNumber}.`,
          type: 'delivery',
          createdAt: new Date(),
          targetUsers: [],
          targetRoles: ['LR2 Leader'],
          readBy: [],
          linkTo: `delivery?orderId=${recordRef.id}`
        };
        batch.set(notifyRef, cleanUndefinedFields(notifyData));
      }

      batch.set(recordRef, cleanUndefinedFields(orderData));

      // 3. Save order to Firestore first
      await batch.commit();

      // 4. Sync receivedQuantity/shippedQuantity into project — read directly from Firestore for fresh data
      const syncProjectUpdates: { moduleId: string; data: Record<string, any>; projectCode?: string }[] = [];

      // Gộp tổng quantity theo moduleCode trước khi sync
      const moduleQtyMap = new Map<string, { totalQty: number; projectCode: string; moduleCode: string }>();
      for (const item of updatedStagedItems) {
        if (!item.id || item.isOverReceived) continue;
        if (item._justCreated) continue;
        const mc = item.moduleCode || '';
        const pc = item.projectCode || targetProjectCode;
        if (!mc || !pc || pc === 'UNASSIGNED') continue;
        const key = `${pc}|${mc}`;
        const existing = moduleQtyMap.get(key);
        if (existing) {
          existing.totalQty += item.quantity || 0;
        } else {
          moduleQtyMap.set(key, { totalQty: item.quantity || 0, projectCode: pc, moduleCode: mc });
        }
      }

      for (const [, { totalQty, projectCode, moduleCode }] of moduleQtyMap) {
        // Tìm module theo moduleCode trong projectConfigs/{projectCode}/modules
        const modulesQ = query(
          collection(db, 'projectConfigs', projectCode, 'modules'),
          where('moduleCode', '==', moduleCode)
        );
        const modulesSnap = await getDocs(modulesQ);
        if (modulesSnap.empty) continue;

        const modDoc = modulesSnap.docs[0];
        const entry = modDoc.data() as ProjectEntry;
        const history = [...(entry.statusHistory || [])];

        if (type === 'receive') {
          const newReceivedCount = Math.min(entry.quantity, (entry.receivedQuantity || 0) + totalQty);
          const isFullyReceived = newReceivedCount >= entry.quantity;
          const newStatus = isFullyReceived ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận';
          if (!history.length || history[history.length - 1].split('|')[0] !== newStatus) {
            history.push(`${newStatus}|${Date.now()}`);
          }
          syncProjectUpdates.push({ moduleId: modDoc.id, data: { receivedQuantity: newReceivedCount, status: newStatus, statusHistory: history }, projectCode });
        } else {
          const newShippedCount = Math.min(entry.quantity, (entry.shippedQuantity || 0) + totalQty);
          const newStatus = 'Giao Nhận - Đang giao';
          if (!history.length || history[history.length - 1].split('|')[0] !== newStatus) {
            history.push(`${newStatus}|${Date.now()}`);
          }
          syncProjectUpdates.push({ moduleId: modDoc.id, data: { shippedQuantity: newShippedCount, status: newStatus, statusHistory: history }, projectCode });
        }
      }

      if (syncProjectUpdates.length > 0) {
        await batchUpdateProjectModules(syncProjectUpdates);
      }

      // Auto-sync checkedQty to pending ship orders for receive flow
      if (type === 'receive') {
        const syncedModules = new Set<string>();
        for (const item of updatedStagedItems) {
          if (!item.moduleCode || item.isOverReceived || item.isUnassigned) continue;
          if (syncedModules.has(item.moduleCode)) continue;
          syncedModules.add(item.moduleCode);
          const totalQty = updatedStagedItems
            .filter(i => i.moduleCode === item.moduleCode && !i.isOverReceived)
            .reduce((sum, i) => sum + (i.quantity || 0), 0);
          const instIds = updatedStagedItems
            .filter(i => i.moduleCode === item.moduleCode)
            .flatMap(i => i.scannedInstanceIds || []);
          await syncCheckedQtyToShipOrders(item.moduleCode, totalQty, instIds.length ? instIds : undefined);
        }
      }

      setStagedItems([]);
      setIsCreating(false);
      if (onComplete) onComplete();
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'projects');
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthorized) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
        <div className="p-4 bg-orange-100 text-orange-500 rounded-full">
          <AlertTriangle size={48} />
        </div>
        <h2 className="text-lg font-black text-gray-800 uppercase tracking-widest">Quyền Truy Cập Bị Từ Chối</h2>
        <p className="text-xs text-gray-500 max-w-xs font-bold">Chỉ Admin, Điều phối (mod), mod_x1/x2 và mod_qc mới có quyền truy cập trang này.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      <div className="flex border-b border-gray-200 pb-2">
        <div className="flex items-center gap-3 w-full">
          <Truck className="text-indigo-600" size={24} />

          <h2 className="text-xl font-black text-gray-800 uppercase tracking-tight">
            Quản Lý Giao Nhận
          </h2>

          {!hasRole('mod_qc') && !activeOrderId && (
            <div className="ml-auto flex items-center gap-2">
              {(hasRole('admin') || hasRole('mod') || hasRole('mod_x1')) && (
                <button
                  onClick={() => handleCreateEmptyOrder('ship')}
                  className="px-4 py-2 bg-primary text-white text-xs font-black uppercase rounded-md shadow-md hover:bg-blue-700 transition-all flex items-center gap-2"
                >
                  <Truck size={16} />
                  <span>Tạo phiếu giao</span>
                </button>
              )}
              {(hasRole('admin') || hasRole('mod') || hasRole('mod_x2')) && (
                <button
                  onClick={() => handleCreateEmptyOrder('receive')}
                  className="px-4 py-2 bg-emerald-600 text-white text-xs font-black uppercase rounded-md shadow-md hover:bg-emerald-700 transition-all flex items-center gap-2"
                >
                  <Package size={16} />
                  <span>Tạo phiếu nhận</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {isCreating && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white w-full max-w-2xl max-h-[90vh] rounded-lg shadow-2xl flex flex-col overflow-hidden border border-slate-200"
            >

              {/* Modal Content */}
              <div className="p-6 space-y-5 overflow-y-auto flex-1">
                {/* Hiện phần chọn loại phiếu Nhận/Giao chỉ dành cho Admin */}
                {hasRole('admin') && (
                  <div className="flex bg-slate-100 p-1 rounded-xl mb-4 gap-1 border border-slate-200/50">
                    <button
                      type="button"
                      onClick={() => { setActiveTab('receive'); setStagedItems([]); }}
                      className={`flex-1 py-2.5 text-xs font-black uppercase rounded-lg transition-all cursor-pointer ${activeTab === 'receive'
                          ? 'bg-white text-indigo-600 border border-slate-200/50'
                          : 'text-slate-500 hover:text-slate-700'
                        }`}
                    >
                      Nhận Hàng (Admin - Không cần QC Hàng Trắng)
                    </button>
                    <button
                      type="button"
                      onClick={() => { setActiveTab('ship'); setStagedItems([]); }}
                      className={`flex-1 py-2.5 text-xs font-black uppercase rounded-lg transition-all cursor-pointer ${activeTab === 'ship'
                          ? 'bg-white text-indigo-600 border border-slate-200/50'
                          : 'text-slate-500 hover:text-slate-700'
                        }`}
                    >
                      Giao Hàng
                    </button>
                  </div>
                )}

                <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-6 relative">
                  <div className="grid grid-cols-2 gap-4">
                    <button
                      onClick={() => setShowScanner(true)}
                      className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-gray-200 rounded-lg hover:border-primary hover:bg-blue-100 transition-all gap-2 group"
                    >
                      <div className="p-3 bg-primary/10 text-primary rounded-full group-hover:bg-primary group-hover:text-white transition-colors">
                        <ScanQrCode size={24} />
                      </div>
                      <span className="text-[10px] font-black uppercase tracking-widest text-gray-500 group-hover:text-primary">Quét Mã QR</span>
                    </button>

                    <button
                      onClick={() => {
                        setShowManualAdd(true);
                        setManualSearchQuery('');
                      }}
                      className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-gray-200 rounded-lg hover:border-primary hover:bg-blue-100 transition-all gap-2 group"
                    >
                      <div className="p-3 bg-primary/10 text-primary rounded-full group-hover:bg-primary group-hover:text-white transition-colors">
                        <Plus size={24} />
                      </div>
                      <span className="text-[10px] font-black uppercase tracking-widest text-gray-500 group-hover:text-primary">Thêm Thủ Công</span>
                    </button>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Tên phiếu (Tùy chọn)</label>
                      <input
                        type="text"
                        placeholder="Để trống để đặt tên mặc định..."
                        className="w-full bg-gray-100 border border-gray-200 rounded-lg px-4 py-3 text-sm focus:border-primary outline-none"
                        value={customTitle}
                        onChange={e => setCustomTitle(e.target.value)}
                      />
                    </div>

                    <div className="flex items-center justify-between border-b border-gray-100 pb-2">
                      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                        Danh sách hạng mục trong phiếu {activeTab === 'receive' ? 'nhận (Không yêu cầu QC Hàng Trắng)' : 'giao'}
                      </h3>
                      <div className="flex gap-2">
                        <span className="text-[10px] bg-blue-100 text-blue-600 px-2 py-0.5 rounded font-bold">
                          {stagedItems.filter(i => i.subType === 'kienModule').reduce((sum, item) => sum + (item.quantity || 0), 0)} MOD
                        </span>
                        <span className="text-[10px] bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded font-bold">
                          {stagedItems.filter(i => i.subType === 'kienPhuKien').reduce((sum, item) => sum + (item.quantity || 0), 0)} CTHT
                        </span>
                      </div>
                    </div>

                    {stagedItems.length > 0 ? (
                      <div className="space-y-3">
                        {stagedItems.map((item, idx) => {
                          const isNormal = !item.isOverReceived && !item.isUnassigned && item.id;
                          const isOverReceived = !!item.isOverReceived;
                          const isUnassigned = !!item.isUnassigned || !item.id;

                          let cardBgClass = "bg-gray-100 border-gray-200";
                          let iconBgClass = "bg-blue-100 text-primary";
                          let tag = null;

                          if (isOverReceived) {
                            cardBgClass = "bg-amber-100/40 border-amber-200/85";
                            iconBgClass = "bg-amber-100 text-amber-700";
                            tag = (
                              <span className="text-[8px] font-black px-1.5 py-0.5 rounded-sm bg-amber-100 text-amber-700 border border-amber-200 uppercase tracking-wider">
                                Nhận dư (Đối chiếu)
                              </span>
                            );
                          } else if (isUnassigned) {
                            cardBgClass = "bg-rose-100/40 border-rose-200/85";
                            iconBgClass = "bg-rose-100 text-rose-700";
                            tag = (
                              <span className="text-[8px] font-black px-1.5 py-0.5 rounded-sm bg-rose-100 text-rose-700 border border-rose-200 uppercase tracking-wider">
                                Mẫu phát sinh (Thêm mới)
                              </span>
                            );
                          }

                          return (
                            <div key={idx} className={`p-3 border rounded flex flex-col gap-2 group transition-all ${cardBgClass}`}>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <div className={`p-2 rounded ${iconBgClass}`}>
                                    <Boxes size={16} />
                                  </div>
                                  <div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="text-xs font-black text-gray-800">{item.moduleCode}</p>
                                      {item.subType && !isOverReceived && !isUnassigned && (
                                        <span className={`text-[7px] font-black px-1 rounded border ${item.subType === 'kienModule' ? 'bg-blue-100 text-blue-600 border-blue-100' : 'bg-indigo-100 text-indigo-600 border-indigo-100'}`}>
                                          {item.subType === 'kienModule' ? 'MOD' : 'CTHT'}
                                        </span>
                                      )}
                                      {tag}
                                    </div>
                                    <p className="text-[10px] text-gray-400 uppercase font-bold tracking-tight">
                                      {item.isUnassigned ? `Tự động gán: ${formatProjectName(item.projectName)} (${item.projectCode})` : (item.id ? `${formatProjectName(item.projectName)} (${item.projectCode})` : 'Phát sinh ngoài')}
                                    </p>
                                  </div>
                                </div>
                                <button onClick={() => removeStagedItem(idx)} className="p-2 text-gray-400 hover:text-red-500 transition-colors cursor-pointer">
                                  <Trash2 size={16} />
                                </button>
                              </div>

                              {item.notes && (
                                <div className="px-2 py-1 bg-white/70 rounded-sm border border-orange-100 text-[9px] font-bold text-amber-600 uppercase tracking-normal">
                                  📌 GHI CHÚ: {item.notes}
                                </div>
                              )}

                              <div className="flex items-center justify-between border-t border-gray-100 pt-2">
                                <div className="text-[9px] text-gray-500 font-bold uppercase">
                                  {item.cluster && <span className="mr-2">{item.cluster}</span>}
                                  <span>{item.width}x{item.depth}x{item.height}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <label className="text-[8px] font-black text-gray-400 uppercase">SL</label>
                                  <input
                                    type="number"
                                    className="w-12 text-center text-xs font-bold bg-white border border-gray-200 rounded py-0.5 focus:border-primary outline-none"
                                    value={item.quantity}
                                    onChange={(e) => updateStagedItemQuantity(idx, Number(e.target.value))}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="py-12 border-2 border-dotted border-gray-100 rounded-lg flex flex-col items-center justify-center text-gray-300 gap-2">
                        <Package size={48} className="opacity-20" />
                        <p className="text-xs font-bold uppercase tracking-widest italic text-center">
                          Chưa có module nào được chọn.<br />Vui lòng quét QR hoặc chọn thủ công.
                        </p>
                      </div>
                    )}

                  </div>
                </div>

              </div>

              {/* Modal Footer */}
              <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-2 shrink-0">
                <button
                  onClick={() => setIsCreating(false)}
                  className="px-5 py-2.5 bg-gray-100 text-gray-500 rounded-lg font-black uppercase text-[10px] tracking-widest hover:bg-gray-200 transition-all"
                >
                  Hủy
                </button>

                {activeTab === 'receive' && stagedItems.some(item => !item.isOverReceived && !item.isUnassigned) && (
                  <button
                    disabled={loading}
                    onClick={handleSubmit}
                    className={`px-4 py-2.5 rounded-lg font-black uppercase text-[10px] tracking-widest shadow-md flex items-center justify-center gap-2 transition-all ${loading ? 'bg-gray-200 text-gray-400' : 'bg-amber-500 text-white hover:bg-amber-600 active:scale-95'}`}
                  >
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    <span>Đồng bộ</span>
                  </button>
                )}

                {stagedItems.length > 0 && (
                  <button
                    disabled={loading}
                    onClick={handleSubmit}
                    className={`px-5 py-2.5 rounded-lg font-black uppercase text-[10px] tracking-widest shadow-md flex items-center justify-center gap-2 transition-all ${loading ? 'bg-gray-200 text-gray-400' : 'bg-primary text-white hover:bg-blue-700 active:scale-95'}`}
                  >
                    {loading ? <Loader2 size={14} className="animate-spin" /> : (
                      <>
                        {activeTab === 'receive' ? <CheckCircle size={14} /> : <Truck size={14} />}
                        <span>Xác nhận {activeTab === 'receive' ? 'nhận hàng' : 'giao hàng'}</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* History Section */}
      <div>
        {activeOrderId && activeOrder ? (
          // VIEW: Chi tiết phiếu giao/nhận
          <div className="space-y-6">
            {/* Header phiếu */}
            <div className="flex items-center gap-3 bg-white rounded-lg border border-gray-100 p-4 shadow-sm">
              <button
                onClick={() => { setActiveOrderId(null); setActiveOrder(null); }}
                className="p-2 border border-slate-200 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors active:scale-95"
              >
                <ArrowLeft size={18} />
              </button>
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <span className={`text-[9px] px-2 py-0.5 rounded-lg font-black uppercase tracking-wider ${activeOrder.type === 'ship' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
                    {activeOrder.type === 'ship' ? 'PHIẾU GIAO' : 'PHIẾU NHẬN'}
                  </span>
                  <h4 className="text-base font-black text-slate-800 uppercase leading-none">
                    {activeOrder.title?.split('-')[1] || `Phiếu ${activeOrder.type === 'ship' ? 'giao' : 'nhận'}`}
                  </h4>
                </div>
                <div className="text-slate-500 mt-1">
                  Dự án: <b>{(() => {
                    const uniqueProjects = Array.from(new Set((activeOrder.items || []).map(i => i.projectCode).filter(Boolean)));
                    const names = uniqueProjects.map(code => {
                      const entry = activeOrder.items?.find(i => i.projectCode === code);
                      return entry?.projectName || code;
                    });
                    return names.join(', ') || 'Chưa xác định';
                  })()}</b>
                </div>
              </div>

              {hasRole('admin') && (
                <button
                  onClick={async () => {
                    if (!confirm(`Xóa phiếu ${activeOrder.type === 'receive' ? 'nhận' : 'giao'} #${activeOrder.sequenceNumber}? Số lượng sẽ được hoàn trả cho dự án.`)) return;
                    setLoading(true);
                    try {
                      const batch = writeBatch(db);
                      const projectReverts: { moduleId: string; data: Record<string, any>; projectCode?: string }[] = [];

                      for (const item of activeOrder.items || []) {
                        if (!item.id) continue;
                        let configId = await findProjectConfigId(item.projectCode || activeOrder.projectCode || '');
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
                          if (activeOrder.type === 'receive') {
                            const newReceived = Math.max(0, (entry.receivedQuantity || 0) - qty);
                            const newStatus = newReceived === 0 ? 'QC - Đạt (Chờ nhận)' : (newReceived >= entry.quantity ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận');
                            history.push(`Hoàn phiếu nhận|${Date.now()}`);
                            projectReverts.push({ moduleId: item.id, data: { receivedQuantity: newReceived, status: newStatus, statusHistory: history }, projectCode: entry.projectCode });
                          } else {
                            const newShipped = Math.max(0, (entry.shippedQuantity || 0) - qty);
                            const newStatus = newShipped === 0 ? 'Giao Nhận - Đã nhận' : (newShipped >= entry.quantity ? 'Giao Nhận - Đã giao' : 'Giao Nhận - Đang giao');
                            history.push(`Hoàn phiếu giao|${Date.now()}`);
                            projectReverts.push({ moduleId: item.id, data: { shippedQuantity: newShipped, status: newStatus, statusHistory: history }, projectCode: entry.projectCode });
                          }
                        }
                      }

                      batch.delete(doc(db, 'shipping_orders', activeOrder.id));

                      const logRef = doc(collection(db, 'activities'));
                      batch.set(logRef, cleanUndefinedFields({
                        userId: user!.uid, userName: user!.displayName || 'Anonymous', userEmail: user!.email,
                        action: 'Hoàn phiếu',
                        details: `Đã hoàn (hủy) phiếu ${activeOrder.type === 'receive' ? 'nhận' : 'giao'} #${activeOrder.sequenceNumber} của dự án ${activeOrder.projectCode}`,
                        projectCode: activeOrder.projectCode,
                        timestamp: serverTimestamp()
                      }));

                      await batch.commit();
                      if (projectReverts.length > 0) {
                        await batchUpdateProjectModules(projectReverts);
                      }
                      showSuccess("Đã hoàn phiếu thành công!");
                      setActiveOrderId(null);
                      setActiveOrder(null);
                    } catch (err) {
                      handleFirestoreError(err, OperationType.UPDATE, 'shipping_orders');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors ml-auto"
                  title="Xóa phiếu (Admin)"
                >
                  <Trash2 size={16} />
                </button>

              )}
            </div>

            {/* Thanh tiến độ - chi cho phieu giao */}
            {activeOrder.type === 'ship' && (
              <div className="bg-white rounded-lg border border-gray-100 p-4 shadow-sm space-y-3">
                <div className="flex items-center justify-between text-xs font-black text-slate-700 uppercase">
                  <span>Tiến độ:</span>
                  <span>
                    {(() => {
                      const total = (activeOrder.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0);
                      const checked = (activeOrder.items || []).reduce((sum, item) => sum + (item.checkedQty || 0), 0);
                      return `${checked}/${total} cấu kiện`;
                    })()}
                  </span>
                </div>
                <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${activeOrder.status === 'completed' ? 'bg-blue-500' : 'bg-blue-500'}`}
                    style={{
                      width: `${(() => {
                        const total = (activeOrder.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0);
                        const checked = (activeOrder.items || []).reduce((sum, item) => sum + (item.checkedQty || 0), 0);
                        return total > 0 ? (checked / total) * 100 : 0;
                      })()}%`
                    }}
                  />
                </div>
              </div>
            )}

            {/* Nút quét QR + Thêm thủ công cùng hàng */}
            <div className="flex gap-2">
              <button
                onClick={() => { setShowManualAddToExisting(true); setManualAddToExistingSearch(''); setManualAddToExistingProject(activeOrder.projectCode || ''); }}
                className="flex-1 flex items-center justify-center gap-2 bg-white border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-slate-700 py-3 rounded-lg font-black uppercase text-xs tracking-widest active:scale-95 transition-all"
              >
                <Plus size={18} />
                Thêm Thủ Công
              </button>
              {activeOrder.type === 'receive' ? (
                <button
                  onClick={() => setShowCheckingScanner(true)}
                  className="flex-1 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-lg font-black uppercase text-xs tracking-widest active:scale-95 transition-all shadow-md"
                >
                  <ScanQrCode size={18} />
                  Quét QR
                </button>
              ) : (
                <button
                  onClick={() => setShowScanner(true)}
                  className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-black uppercase text-xs tracking-widest active:scale-95 transition-all shadow-md"
                >
                  <ScanQrCode size={18} />
                  Quét QR
                </button>
              )}
            </div>

            {/* Danh sách hạng mục */}
            <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
              <div className="px-4 py-3 border-b border-gray-200">
                <h4 className="text-xs font-black text-slate-700 uppercase tracking-wider">Danh Sách Hạng Mục ({activeOrder.items?.length || 0})</h4>
              </div>
              <div className="divide-y divide-gray-50">
                {(activeOrder.items || []).length > 0 ? (
                  (activeOrder.items || []).map((item, idx) => {
                    const isChecked = (item.checkedQty || 0) >= item.quantity;
                    const isPartial = !isChecked && (item.checkedQty || 0) > 0;

                    // Badge mau cho phieu giao
                    const shipBadge = activeOrder.type === 'ship' ? (
                      isChecked ? 'bg-emerald-100 text-emerald-600 border-emerald-200'
                        : isPartial ? 'bg-amber-100 text-amber-600 border-amber-200'
                          : 'bg-slate-100 text-slate-400 border-slate-200'
                    ) : '';

                    // Badge mau cho phieu nhan
                    const receiveBadge = activeOrder.type === 'receive' && item.syncStatus ? (
                      item.syncStatus === 'synced' ? 'bg-emerald-100 text-emerald-600 border-emerald-200'
                        : item.syncStatus === 'unmatched' ? 'bg-amber-100 text-amber-600 border-amber-200'
                          : 'bg-rose-100 text-rose-600 border-rose-200'
                    ) : '';

                    return (
                      <div key={idx} className="px-4 py-3 flex items-center gap-3">
                        <span className="shrink-0 w-8 h-8 flex items-center justify-center text-[11px] font-black text-slate-500">
                          {idx + 1}
                        </span>
                        {(activeOrder.type === 'ship' || activeOrder.type === 'receive') && (
                          <span className={`shrink-0 text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-sm border ${activeOrder.type === 'ship' ? shipBadge : receiveBadge}`}>
                            <span className="sm:hidden">{activeOrder.type === 'ship' ? (isChecked ? '✓' : isPartial ? '~' : '/') : (item.syncStatus === 'synced' ? '✓' : item.syncStatus === 'unmatched' ? '!' : '?')}</span>
                            <span className="hidden sm:inline">{activeOrder.type === 'ship' ? (isChecked ? 'ĐÃ NHẬN' : isPartial ? 'ĐANG GIAO' : 'CHỜ') : (item.syncStatus === 'synced' ? 'ĐÃ ĐỒNG BỘ' : item.syncStatus === 'unmatched' ? 'CHƯA CÓ PHIẾU GIAO' : 'KHÔNG TRONG HT')}</span>
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <h5 className="text-[13px] font-black text-slate-800 uppercase tracking-tight truncate">{item.moduleCode || item.name}</h5>
                          <span className="text-[8px] text-slate-400 font-bold truncate">{item.projectCode || 'N/A'}{item.cluster ? ` · ${item.cluster}` : ''}</span>
                        </div>
                        <div className="shrink-0 text-right">
                          {activeOrder.type === 'ship' ? (
                            <p className="font-black text-slate-700">{item.checkedQty || 0}/{item.quantity}</p>
                          ) : (
                            <p className="text-xs font-black text-slate-700">{item.quantity}</p>
                          )}
                        </div>
                        <button
                          onClick={async () => {
                            if (!confirm(`Xóa "${item.moduleCode}" khỏi phiếu?`)) return;
                            const updatedItems = (activeOrder.items || []).filter((_, i) => i !== idx);
                            try {
                              setLoading(true);
                              await updateDoc(doc(db, 'shipping_orders', activeOrder.id), { items: updatedItems });

                              // Với phiếu nhận: đồng bộ xóa khỏi phiếu giao và dự án
                              if (activeOrder.type === 'receive' && item.moduleCode) {
                                // 1. Đồng bộ phiếu giao: giảm checkedQty và xóa scannedInstanceIds
                                for (const order of pendingShipOrders) {
                                  const matchedItemIdx = order.items.findIndex(i =>
                                    i.moduleCode?.toLowerCase() === item.moduleCode?.toLowerCase()
                                  );
                                  if (matchedItemIdx === -1) continue;

                                  const matchedItem = order.items[matchedItemIdx];
                                  const removedQty = item.quantity || 0;
                                  const newCheckedQty = Math.max(0, (matchedItem.checkedQty || 0) - removedQty);
                                  const removedIds = new Set(item.scannedInstanceIds || []);
                                  const newScannedIds = (matchedItem.scannedInstanceIds || []).filter(
                                    (sid: string) => !removedIds.has(sid)
                                  );

                                  const newOrderItems = order.items.map((oi, i) => {
                                    if (i === matchedItemIdx) {
                                      return { ...oi, checkedQty: newCheckedQty, scannedInstanceIds: newScannedIds };
                                    }
                                    return oi;
                                  });
                                  const isAllCompleted = newOrderItems.every(i => (i.checkedQty || 0) >= i.quantity);
                                  await updateDoc(doc(db, 'shipping_orders', order.id), {
                                    items: newOrderItems,
                                    status: isAllCompleted ? 'completed' : 'pending'
                                  });
                                }

                                // 2. Đồng bộ dự án: giảm receivedQuantity và đánh dấu delivered = false
                                const entry = projectEntries.find(e =>
                                  e.moduleCode?.toLowerCase() === item.moduleCode?.toLowerCase()
                                  && e.projectCode === (item.projectCode || activeOrder.projectCode)
                                );
                                if (entry?.id && entry?.projectCode) {
                                  try {
                                    const configId = entry.configId || await findProjectConfigId(entry.projectCode);
                                    if (configId) {
                                      const entrySnap = await getDoc(doc(db, 'projectConfigs', configId, 'modules', entry.id));
                                      if (entrySnap.exists()) {
                                        const entryData = entrySnap.data() as ProjectEntry;
                                        const currentInstances = getModuleInstances(entryData);
                                        const removedInstanceIds = new Set(item.scannedInstanceIds || []);

                                        const updatedInstances = currentInstances.map(inst => {
                                          const instId = inst.instanceId || inst.id;
                                          if (removedInstanceIds.has(instId) || removedInstanceIds.has(String(inst.instanceIndex))) {
                                            return { ...inst, delivered: false };
                                          }
                                          return inst;
                                        });

                                        const removedQty = item.quantity || 0;
                                        const newReceivedQty = Math.max(0, (entryData.receivedQuantity || 0) - removedQty);
                                        const isFullyReceived = newReceivedQty >= entryData.quantity;
                                        const newStatus = newReceivedQty === 0 ? 'QC - Đạt (Chờ nhận)' : (isFullyReceived ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận');
                                        const history = [...(entryData.statusHistory || [])];
                                        history.push(`Giao Nhận - Đã xóa ${removedQty} (${userProfile?.ten_that || user?.displayName || 'Unknown'})|${Date.now()}`);

                                        await updateProjectModule(entry.id, {
                                          instances: updatedInstances,
                                          receivedQuantity: newReceivedQty,
                                          status: newStatus,
                                          statusHistory: history
                                        }, entry.projectCode);
                                      }
                                    }
                                  } catch (e) {
                                    console.error('Lỗi đồng bộ xóa khỏi dự án:', e);
                                  }
                                }
                              }

                              showSuccess(`Đã xóa "${item.moduleCode}" khỏi phiếu`);
                            } catch (err) {
                              handleFirestoreError(err, OperationType.UPDATE, 'shipping_orders');
                            } finally {
                              setLoading(false);
                            }
                          }}
                          className="shrink-0 p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div className="py-12 text-center text-slate-400">
                    <Package size={40} className="mx-auto mb-3 opacity-30" />
                    <p className="text-xs font-black uppercase tracking-widest">Chưa có hạng mục nào</p>
                    <p className="text-[11px] text-slate-400 font-medium mt-1">Quét QR hoặc thêm thủ công để bắt đầu</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          // VIEW: Danh sách phiếu
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <DeliveryListScreen hideHeader={true} initialOrderId={initialOrderId} onSelectOrder={onSelectOrder || ((orderId) => setActiveOrderId(orderId))} />
          </div>
        )}
      </div>

      {/* Manual Add Modal */}
      <AnimatePresence>
        {showManualAdd && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white w-full max-w-lg rounded-lg shadow-2xl flex flex-col max-h-[85vh] border border-slate-200"
            >
              <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center border border-indigo-100">
                    <Plus size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-black text-slate-800 uppercase tracking-tight leading-none">Thêm Module Thủ Công</h3>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Dự án:</label>
                      <select
                        className="bg-slate-100 border border-slate-200 rounded px-2 py-1 text-[10px] font-black text-slate-600 outline-none focus:border-indigo-600 transition-all uppercase"
                        value={manualAddProject}
                        onChange={(e) => {
                          setManualAddProject(e.target.value);
                          setManualSearchQuery('');
                        }}
                      >
                        <option value="">-- Chọn dự án --</option>
                        {projects.map(code => {
                          return (
                            <option key={code} value={code}>{formatProjectCode(code)}</option>
                          );
                        })}
                      </select>
                    </div>
                  </div>
                </div>
                <button onClick={() => setShowManualAdd(false)} className="p-2 text-slate-400 hover:text-rose-500 transition-colors">
                  <X size={20} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar bg-slate-100/30 flex flex-col">
                {/* BỘ LỌC TÌM KIẾM MÃ MODULE */}
                {manualAddProject && (
                  <div className="space-y-1.5 shrink-0">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block leading-none">
                      Tìm kiếm theo tên hoặc mã Module / Cấu kiện:
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="Nhập phần tên, mã cấu kiện, phân loại để lọc..."
                        className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-xs font-bold text-slate-800 placeholder-slate-400 outline-none focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/10 transition-all"
                        value={manualSearchQuery}
                        onChange={(e) => setManualSearchQuery(e.target.value)}
                        id="manual-search-query-input"
                      />
                      {manualSearchQuery && (
                        <button
                          type="button"
                          onClick={() => setManualSearchQuery('')}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-black text-rose-500 hover:text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded uppercase tracking-wider cursor-pointer"
                        >
                          Xóa
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* THANH CHỌN CHẾ ĐỘ THÊM THỦ CÔNG */}
                <div className="space-y-1.5 shrink-0">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none block">
                    Tùy chọn thêm thủ công:
                  </label>
                  <div className="flex bg-slate-100 p-1 rounded-lg gap-1 border border-slate-200/50">
                    <button
                      type="button"
                      onClick={() => setManualAddMode('thung')}
                      className={`flex-1 py-2 text-[10px] font-black uppercase rounded-sm transition-all cursor-pointer ${manualAddMode === 'thung'
                          ? 'bg-white text-indigo-600 border border-slate-200/50 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100/50'
                        }`}
                    >
                      Thùng
                    </button>
                    <button
                      type="button"
                      onClick={() => setManualAddMode('hang_son')}
                      className={`flex-1 py-2 text-[10px] font-black uppercase rounded-sm transition-all cursor-pointer ${manualAddMode === 'hang_son'
                          ? 'bg-white text-indigo-600 border border-slate-200/50 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100/50'
                        }`}
                    >
                      Hàng Sơn
                    </button>
                    <button
                      type="button"
                      onClick={() => setManualAddMode('all')}
                      className={`flex-1 py-2 text-[10px] font-black uppercase rounded-sm transition-all cursor-pointer ${manualAddMode === 'all'
                          ? 'bg-white text-indigo-600 border border-slate-200/50 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100/50'
                        }`}
                    >
                      Toàn Bộ
                    </button>
                  </div>
                </div>

                <div className="bg-indigo-100 p-4 rounded-lg border border-indigo-100 flex items-start gap-3 shrink-0">
                  <AlertTriangle size={18} className="text-indigo-600 shrink-0 mt-0.5" />
                  <p className="text-[11px] font-black text-indigo-700 uppercase leading-relaxed tracking-tight">
                    {manualAddMode === 'thung' && "CHẾ ĐỘ THÙNG: Chọn Thùng sẽ thêm Thùng + các Đợt con chưa giao đủ. Khi kiểm hàng chỉ kiểm quét module Thùng."}
                    {manualAddMode === 'hang_son' && "CHẾ ĐỘ HÀNG SƠN: Chọn Thùng sẽ thêm toàn bộ Cánh, Mặt HK, CTHT con chưa giao đủ. Khi kiểm hàng quét các Độc lập."}
                    {manualAddMode === 'all' && `CHẾ ĐỘ TOÀN BỘ: Hiển thị tất cả cấu kiện lẻ trong dự án chưa giao đủ.`}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 flex-1">
                  {manualAddProject ? (
                    (() => {
                      const listToShow = getFilteredAvailableModules();
                      return listToShow.length > 0 ? (
                        listToShow.map(module => (
                          <button
                            key={module.id}
                            onClick={() => handleAddManualItem(module)}
                            className="w-full p-4 flex items-center justify-between bg-white hover:bg-slate-100 border border-slate-200 hover:border-indigo-300 rounded-lg transition-all text-left shadow-sm group"
                          >
                            <div className="flex items-center gap-4">
                              <div className="w-10 h-10 bg-slate-100 rounded-lg text-slate-400 group-hover:text-indigo-600 transition-colors flex items-center justify-center border border-slate-100">
                                <Plus size={18} />
                              </div>
                              <div>
                                <p className="text-sm font-black text-slate-800 tracking-tight uppercase">{module.moduleCode}</p>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest leading-none">
                                    {(module.classification || getEntryType(module))} {module.cluster ? `• ${module.cluster}` : ''}
                                  </span>
                                  <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
                                  <span className="text-[10px] text-indigo-600 font-black uppercase tracking-widest leading-none">
                                    {manualAddMode === 'thung' ? (
                                      `Thùng còn SL: ${module.quantity - (module.receivedQuantity || 0) - stagedItems.filter(item => item.id === module.id).reduce((sum, item) => sum + (item.quantity || 0), 0)}`
                                    ) : manualAddMode === 'hang_son' ? (
                                      `Có hàng sơn con`
                                    ) : (
                                      `Còn SL: ${module.quantity - (module.receivedQuantity || 0) - stagedItems.filter(item => item.id === module.id).reduce((sum, item) => sum + (item.quantity || 0), 0)}`
                                    )}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <div className="text-right border-l border-slate-100 pl-4">
                              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Tổng SL</p>
                              <p className="text-lg font-black text-slate-900 tracking-tighter leading-none mt-1">{module.quantity}</p>
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="py-24 text-center space-y-4 opacity-100">
                          <div className="w-20 h-20 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto border border-slate-200">
                            <Package size={36} className="text-slate-400" />
                          </div>
                          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Không còn module nào phù hợp</p>
                        </div>
                      )
                    })()
                  ) : (
                    <div className="py-24 text-center space-y-4 opacity-40">
                      <div className="w-20 h-20 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto border border-slate-200">
                        <Truck size={36} className="text-slate-400" />
                      </div>
                      <p className="text-[11px] font-black uppercase tracking-[0.2em] italic">Vui lòng chọn dự án</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-4 border-t border-slate-100 bg-white">
                <button
                  onClick={() => setShowManualAdd(false)}
                  className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase text-xs tracking-widest transition-all active:scale-95 shadow-md shadow-indigo-600/15"
                >
                  Hoàn thành
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Scanned Confirmation Modal */}
      <AnimatePresence>
        {scannedResult && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 10 }}
              className={`bg-white rounded-lg shadow-2xl w-full max-w-sm overflow-hidden border border-slate-200 flex flex-col`}
            >
              <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${scannedResult.isMatched ? 'bg-emerald-100 text-emerald-600 border-emerald-100' : 'bg-amber-100 text-amber-600 border-amber-100'}`}>
                    {scannedResult.isMatched ? <CheckCircle size={22} /> : <AlertTriangle size={22} />}
                  </div>
                  <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">Xác Nhận Hàng Quét</h3>
                </div>
                <button onClick={() => setScannedResult(null)} className="p-2 text-slate-400 hover:text-rose-500 transition-colors">
                  <X size={20} />
                </button>
              </div>

              <div className="p-8 text-center space-y-7">
                <div className="space-y-2">
                  <p className={`text-[11px] font-black uppercase tracking-widest ${scannedResult.isMatched ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {scannedResult.isMatched ? 'Tìm thấy trong dự án' : 'Không tìm thấy trong dự án'}
                  </p>
                  <div className={`h-1 w-12 mx-auto rounded-full ${scannedResult.isMatched ? 'bg-emerald-500' : 'bg-amber-500'}`}></div>
                </div>

                <div className="bg-slate-100 p-6 rounded-lg border border-slate-100 space-y-4 text-left">
                  <div className="flex justify-between items-center border-b border-slate-200 pb-3">
                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Mã Module</span>
                    <span className="text-sm font-black text-slate-800 font-mono uppercase bg-white px-2 py-0.5 rounded border border-slate-100">{scannedResult.moduleCode}</span>
                  </div>
                  {scannedResult.isMatched && (
                    <div className="flex justify-between items-center border-b border-slate-200 pb-3">
                      <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Dự án</span>
                      <span className="text-xs font-black text-slate-700 uppercase truncate max-w-[150px]">{scannedResult.projectName}</span>
                    </div>
                  )}
                  {(() => {
                    const matchedEntry = projectEntries.find(e => e.id === scannedResult.matchedId) || projectEntries.find(e => (e.moduleCode || '').toLowerCase() === (scannedResult.moduleCode || '').toLowerCase());
                    if (matchedEntry && matchedEntry.moduleType === 'bo') {
                      return (
                        <div className="flex justify-between items-center border-b border-slate-200 pb-3 bg-indigo-100/25 p-2 rounded">
                          <span className="text-[10px] text-indigo-600 font-bold uppercase tracking-widest">Tiến độ Bộ</span>
                          <span className="text-xs font-black text-indigo-700">
                            Loại Bộ | Đã {activeTab === 'receive' ? 'nhận' : 'giao'}: {activeTab === 'receive' ? matchedEntry.receivedQuantity || 0 : matchedEntry.shippedQuantity || 0} / {matchedEntry.quantity}
                          </span>
                        </div>
                      );
                    }
                    return null;
                  })()}
                  <div className="flex justify-between items-center pb-1">
                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Kích thước</span>
                    <span className="text-xs font-black text-slate-700 font-mono italic">{scannedResult.width}x{scannedResult.depth}x{scannedResult.height}</span>
                  </div>

                  <div className="flex justify-between items-center pt-3 border-t border-slate-200">
                    <span className="text-[10px] text-indigo-600 font-black uppercase tracking-widest">Số lượng {activeTab === 'receive' ? 'nhận' : 'giao'}</span>
                    <input
                      type="number"
                      min="1"
                      value={scanConfirmQty}
                      onChange={(e) => {
                        const val = e.target.value;
                        setScanConfirmQty(val === '' ? '' : Math.max(1, parseInt(val, 10)));
                      }}
                      onFocus={(e) => e.target.select()}
                      placeholder="1"
                      className="w-16 px-2 py-1 text-center font-black text-xs text-indigo-600 border border-indigo-200 rounded bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                  </div>
                </div>

                {!scannedResult.isMatched && (
                  <div className="p-3 bg-rose-100 border border-rose-100 rounded-lg">
                    <p className="text-[10px] text-rose-600 font-black italic uppercase tracking-tight leading-relaxed">
                      * Module này sẽ được thêm vào phiếu như hạng mục phát sinh.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex bg-slate-100 border-t border-slate-100 p-5 space-x-3">
                <button onClick={() => setScannedResult(null)} className="px-6 py-3 text-slate-600 font-black text-[10px] uppercase border border-slate-200 bg-white hover:bg-slate-100 rounded-lg transition-all tracking-widest">
                  Hủy
                </button>

                <button
                  onClick={() => activeOrderId ? handleAddToExistingOrder(scannedResult) : onScanConfirm(scannedResult)}
                  className={`flex-1 py-3 text-white font-black uppercase text-[11px] tracking-widest transition-all shadow-xl rounded-lg flex items-center justify-center gap-2 ${scannedResult.isMatched ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-100' : 'bg-amber-500 hover:bg-amber-600 shadow-amber-100'}`}
                >
                  Xác Nhận
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Manual Add To Existing Order Modal */}
      <AnimatePresence>
        {showManualAddToExisting && activeOrder && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white w-full max-w-lg rounded-lg shadow-2xl flex flex-col max-h-[85vh] border border-slate-200"
            >
              <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center border border-indigo-100">
                    <Plus size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-black text-slate-800 uppercase tracking-tight leading-none">Thêm Cấu Kiện Thủ Công</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                      Vào {activeOrder.type === 'ship' ? 'Phiếu Giao' : 'Phiếu Nhận'}
                    </p>
                  </div>
                </div>
                <button onClick={() => setShowManualAddToExisting(false)} className="p-2 text-slate-400 hover:text-rose-500 transition-colors">
                  <X size={18} />
                </button>
              </div>

              <div className="p-4 space-y-3 border-b border-slate-100 bg-slate-50">
                {/* Chọn dự án */}
                <div className="flex items-center gap-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest shrink-0">Dự án:</label>
                  <select
                    className="flex-1 bg-white border border-slate-200 rounded px-2 py-1.5 text-[10px] font-black text-slate-600 outline-none focus:border-indigo-600 transition-all uppercase"
                    value={manualAddToExistingProject}
                    onChange={(e) => { setManualAddToExistingProject(e.target.value); setManualAddToExistingSearch(''); }}
                  >
                    <option value="">-- Chọn dự án --</option>
                    {projects.map(code => (
                      <option key={code} value={code}>{formatProjectCode(code)}</option>
                    ))}
                  </select>
                </div>

                {/* Chế độ lọc */}
                <div className="flex bg-white p-1 rounded-lg gap-1 border border-slate-200">
                  {([
                    { id: 'all' as const, label: 'Toàn Bộ' },
                    { id: 'thung' as const, label: 'Thùng' },
                    { id: 'hang_son' as const, label: 'Hàng Sơn' },
                  ]).map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => setManualAddToExistingMode(opt.id)}
                      className={`flex-1 py-1.5 text-[10px] font-black uppercase rounded-sm transition-all cursor-pointer ${manualAddToExistingMode === opt.id
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {/* Tìm kiếm */}
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Nhập mã cấu kiện để tìm..."
                    value={manualAddToExistingSearch}
                    onChange={(e) => setManualAddToExistingSearch(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg pl-3 pr-8 py-2 text-xs font-bold text-slate-800 outline-none focus:border-indigo-500 transition-all"
                    autoFocus
                  />
                  {manualAddToExistingSearch && (
                    <button onClick={() => setManualAddToExistingSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>

              {/* Danh sách kết quả */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {(() => {
                  if (!manualAddToExistingProject) {
                    return <div className="py-12 text-center text-slate-400 text-xs font-bold uppercase">Chọn dự án để hiển thị cấu kiện</div>;
                  }

                  const existingItems = activeOrder.items || [];

                  let filtered = projectEntries.filter(e =>
                    e.projectCode === manualAddToExistingProject && !e.isCompleted
                  );

                  // Lọc theo chế độ
                  if (manualAddToExistingMode === 'thung') {
                    filtered = filtered.filter(e => {
                      const t = (e.classification || '') as string;
                      const lower = (e.moduleCode || '').toLowerCase();
                      return t === 'Thùng' || lower.includes('thung');
                    });
                  } else if (manualAddToExistingMode === 'hang_son') {
                    filtered = filtered.filter(e => {
                      const t = (e.classification || '') as string;
                      return t === 'Cánh' || t === 'Mặt HK' || t === 'CTHT';
                    });
                  }

                  // Tìm kiếm theo mã
                  if (manualAddToExistingSearch.trim()) {
                    const term = manualAddToExistingSearch.toLowerCase().trim();
                    filtered = filtered.filter(e =>
                      (e.moduleCode || '').toLowerCase().includes(term) ||
                      (e.cluster || '').toLowerCase().includes(term)
                    );
                  }

                  if (filtered.length === 0) {
                    return <div className="py-12 text-center text-slate-400 text-xs font-bold uppercase">Không tìm thấy cấu kiện phù hợp</div>;
                  }

                  return filtered.filter(entry => {
                    const remaining = (entry.quantity || 1) - (entry.receivedQuantity || 0);
                    return remaining > 0;
                  }).map(entry => {
                    const instances = getModuleInstances(entry);
                    const totalQty = entry.quantity || 1;
                    const deliveredQty = entry.receivedQuantity || 0;
                    const remaining = totalQty - deliveredQty;

                    // Kiểm tra từng instance đã có trong phiếu chưa
                    const existingItemForModule = existingItems.find(i => i.id === entry.id);
                    const existingScannedIds = new Set(existingItemForModule?.scannedInstanceIds || []);

                    // Với phiếu nhận: tìm instance có trong phiếu giao nhưng chưa nhận
                    const isInShipOrder = activeOrder?.type === 'receive' && pendingShipOrders.some(order =>
                      order.items?.some(item =>
                        (item.moduleCode || '').toLowerCase() === (entry.moduleCode || '').toLowerCase()
                        && (item.checkedQty || 0) < item.quantity
                      )
                    );

                    return (
                      <div key={entry.id} className="p-3 rounded-lg border transition-all bg-white border-slate-200 hover:border-indigo-300">
                        <div className="flex items-center justify-between">
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-black text-slate-800 uppercase truncate">{entry.moduleCode}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[9px] text-slate-400 font-bold uppercase">{entry.cluster || 'N/A'}</span>
                              <span className="text-[9px] text-slate-400">•</span>
                              <span className="text-[9px] font-black text-slate-500">SL: {totalQty} | Còn: {remaining}</span>
                              {isInShipOrder && <span className="text-[9px] font-black text-amber-500">• Cần nhận</span>}
                            </div>
                          </div>
                          <div className="shrink-0 ml-3">
                            <div className="grid grid-cols-5 gap-1">
                              {instances.map(inst => {
                                const instDelivered = inst.delivered ? 1 : 0;
                                const instId = inst.instanceId || inst.id || `${entry.moduleCode}|${inst.instanceIndex}`;
                                const instAlreadyInOrder = existingScannedIds.has(instId) || existingScannedIds.has(String(inst.instanceIndex));
                                const isAdded = instAlreadyInOrder || instDelivered > 0;
                                const isPendingReceive = isInShipOrder && !isAdded;
                                return (
                                  <button
                                    key={inst.instanceIndex}
                                    disabled={isAdded}
                                    onClick={() => {
                                      if (!activeOrder || !user) return;
                                      const result: ScannedResult = {
                                        moduleCode: entry.moduleCode,
                                        rawCode: entry.moduleCode,
                                        isMatched: true,
                                        matchedId: entry.id,
                                        projectCode: entry.projectCode,
                                        projectName: entry.projectName,
                                        cluster: entry.cluster,
                                        width: entry.pWidth || entry.width || 0,
                                        depth: entry.pDepth || entry.depth || 0,
                                        height: entry.pHeight || entry.height || 0,
                                        instanceId: instId,
                                        isNewChildOfParent: false,
                                      };
                                      handleAddToExistingOrder(result, 1);
                                      showSuccess(`Đã thêm "${entry.moduleCode}" #${inst.instanceIndex} vào phiếu!`);
                                    }}
                                    className={`w-8 h-8 rounded text-[10px] font-black border transition-all ${
                                      isAdded
                                        ? 'bg-emerald-100 text-emerald-500 border-emerald-200 cursor-not-allowed'
                                        : isPendingReceive
                                          ? 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600 cursor-pointer active:scale-95'
                                          : 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700 cursor-pointer active:scale-95'
                                    }`}
                                    title={isAdded ? 'Đã có trong phiếu' : isPendingReceive ? `Nhận #${inst.instanceIndex}` : `Thêm #${inst.instanceIndex}`}
                                  >
                                    {isAdded ? '✓' : `#${inst.instanceIndex}`}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>

              <div className="p-4 border-t border-slate-100 bg-white">
                <button
                  onClick={() => setShowManualAddToExisting(false)}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase text-xs tracking-widest transition-all active:scale-95"
                >
                  Xong
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Scanner Overlay */}
      {showScanner && (
        <ScannerModal
          onClose={() => setShowScanner(false)}
          onScan={(res) => {
            // Đang xem chi tiết phiếu → thêm trực tiếp, bỏ qua modal xác nhận
            if (activeOrderId && activeOrder) {
              const matched = getMatchedEntryDelivery(res);
              const scanResult: ScannedResult = matched ? {
                ...res,
                moduleCode: matched.moduleCode,
                isMatched: true,
                matchedId: matched.id,
                projectCode: matched.projectCode,
                projectName: matched.projectName,
                cluster: matched.cluster,
                width: matched.pWidth || matched.width || res.width || 0,
                depth: matched.pDepth || matched.depth || res.depth || 0,
                height: matched.pHeight || matched.height || res.height || 0,
                isNewChildOfParent: false,
                parentModuleCode: undefined
              } : {
                ...res,
                isMatched: false,
                matchedId: undefined,
              };
              handleAddToExistingOrder(scanResult);
              return;
            }

            // Đang tạo phiếu mới → hiện modal xác nhận như cũ
            const matched = getMatchedEntryDelivery(res);
            if (matched) {
              setScannedResult({
                ...res,
                moduleCode: matched.moduleCode,
                isMatched: true,
                matchedId: matched.id,
                projectCode: matched.projectCode,
                projectName: matched.projectName,
                cluster: matched.cluster,
                width: matched.pWidth || matched.width || res.width || 0,
                depth: matched.pDepth || matched.depth || res.depth || 0,
                height: matched.pHeight || matched.height || res.height || 0,
                isNewChildOfParent: false,
                parentModuleCode: undefined
              });
            } else {
              setScannedResult({
                ...res,
                isMatched: false,
                matchedId: undefined,
              });
            }
            setScanConfirmQty(1);
          }}
          projectEntries={projectEntries}
        />
      )}

      {/* Scanner Kiem Hang */}
      {showCheckingScanner && (
        <ScannerModal
          onClose={() => setShowCheckingScanner(false)}
          onScan={handleCheckingScan}
          projectEntries={projectEntries}
        />
      )}
    </div>
  );
}
