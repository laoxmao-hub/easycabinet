import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { initializeFirestore, doc, getDoc, setDoc, getDocFromServer, persistentLocalCache, persistentMultipleTabManager, getFirestore } from "firebase/firestore";
import firebaseConfig from "@/firebase-applet-config.json";

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Services with long-polling enabled to avoid WebSocket connection blocks inside sandboxed runtimes/iframes
const firestoreDbId = (firebaseConfig as any).firestoreDatabaseId && (firebaseConfig as any).firestoreDatabaseId !== "(default)"
 ? (firebaseConfig as any).firestoreDatabaseId
 : undefined;

// Sử dụng cache dạng SDK thế mới với persistentLocalCache và persistentMultipleTabManager để phân phối đa tab tối ưu
// Bọc trong try-catch để phòng ngừa lỗi chặn IndexedDB trong iframe của các trình duyệt di động (như Safari di động, Chrome Incognito)
let dbInstance;
try {
 const firestoreSettings = {
 experimentalForceLongPolling: true,
 cache: persistentLocalCache({
 tabManager: persistentMultipleTabManager(),
 }),
 };
 
 dbInstance = firestoreDbId
 ? initializeFirestore(app, firestoreSettings, firestoreDbId)
 : initializeFirestore(app, firestoreSettings);
} catch (error) {
 console.warn("Failed to initialize Firestore with persistentLocalCache (likely due to third-party storage restrictions in mobile iframe). Falling back to non-cached settings.", error);
 try {
 const fallbackSettings = {
 experimentalForceLongPolling: true
 };
 dbInstance = firestoreDbId
 ? initializeFirestore(app, fallbackSettings, firestoreDbId)
 : initializeFirestore(app, fallbackSettings);
 } catch (fallbackError) {
 console.error("Critical fallback failed: Falling back to getFirestore()", fallbackError);
 dbInstance = getFirestore(app);
 }
}

export const db = dbInstance;

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Error handling types
export enum OperationType {
 CREATE = 'create',
 UPDATE = 'update',
 DELETE = 'delete',
 LIST = 'list',
 GET = 'get',
 WRITE = 'write',
}

export interface FirestoreErrorInfo {
 error: string;
 operationType: OperationType;
 path: string | null;
 authInfo: {
 userId?: string | null;
 email?: string | null;
 emailVerified?: boolean | null;
 isAnonymous?: boolean | null;
 tenantId?: string | null;
 providerInfo?: {
 providerId?: string | null;
 email?: string | null;
 }[];
 }
}

/**
 * Recursively removes all properties with `undefined` values from an object,
 * preventing Firestore from crashing with "Unsupported field value: undefined" errors.
 */
export function cleanUndefinedFields<T = any>(obj: T): T {
 if (obj === null || obj === undefined) {
 return obj;
 }
 
 if (Array.isArray(obj)) {
 return obj.map(item => cleanUndefinedFields(item)) as any;
 }
 
 if (typeof obj === 'object') {
 // Bảo vệ đối tượng Date chuẩn
 if (obj instanceof Date) {
 return obj;
 }
 // Bảo vệ các đối tượng đặc tả đặc biệt của Firebase không bị clone làm hỏng cấu trúc
 if (
 (obj.constructor && (
 obj.constructor.name.includes('FieldValue') || 
 obj.constructor.name.includes('Timestamp')
 )) || 
 typeof (obj as any).toDate === 'function'
 ) {
 return obj;
 }

 const copy: any = {};
 for (const key in obj) {
 if (Object.prototype.hasOwnProperty.call(obj, key)) {
 const val = (obj as any)[key];
 if (val !== undefined) {
 copy[key] = cleanUndefinedFields(val);
 }
 }
 }
 return copy as T;
 }
 
 return obj;
}

/**
 * Standard error handler for Firestore operations to provide diagnostic context.
 */
export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
 const errInfo: FirestoreErrorInfo = {
 error: error instanceof Error ? error.message : String(error),
 authInfo: {
 userId: auth.currentUser?.uid,
 email: auth.currentUser?.email,
 emailVerified: auth.currentUser?.emailVerified,
 isAnonymous: auth.currentUser?.isAnonymous,
 tenantId: auth.currentUser?.tenantId,
 providerInfo: auth.currentUser?.providerData?.map(provider => ({
 providerId: provider.providerId,
 email: provider.email,
 })) || []
 },
 operationType,
 path
 }
 console.error('Firestore Error: ', JSON.stringify(errInfo));
 throw new Error(JSON.stringify(errInfo));
}

// Test Connection
async function testConnection() {
 try {
 // We try to read a doc to ensure Firestore is reachable
 await getDocFromServer(doc(db, 'test', 'connection'));
 } catch (error: any) {
 // Only warn if truly offline or config is fundamentally broken
 if (error.message?.includes('the client is offline') || error.code === 'unavailable') {
 console.warn("Firebase check: Client seems offline or service is unavailable. This is often normal during initial load or dev refresh.");
 } else {
 // Permission denied or other errors are fine, it means we reached the server
 console.log("Firebase check: Connection verified (Server reached).");
 }
 }
}

testConnection();

// ── Customers CRUD ──────────────────────────────────────────────

import {
  addDoc, updateDoc, deleteDoc, onSnapshot, query as fbQuery, collection as fbCollection
} from 'firebase/firestore';

export async function addCustomer(data: {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  loginId?: string;
  loginPass?: string;
  projects: { code: string; subCodes: string[] }[];
  type?: 'customer' | 'worksite';
  note?: string;
  createdBy: string;
}): Promise<string> {
  const docRef = await addDoc(fbCollection(db, 'customers'), {
    ...data,
    createdAt: new Date(),
  });
  return docRef.id;
}

export async function updateCustomer(id: string, data: Partial<{
  name: string;
  phone: string;
  email: string;
  address: string;
  loginId: string;
  loginPass: string;
  projects: { code: string; subCodes: string[] }[];
  type: 'customer' | 'worksite';
  note: string;
}>): Promise<void> {
  await updateDoc(doc(db, 'customers', id), {
    ...data,
    updatedAt: new Date(),
  });
}

export async function deleteCustomer(id: string): Promise<void> {
  await deleteDoc(doc(db, 'customers', id));
}

export function onCustomersSnapshot(callback: (customers: any[]) => void): () => void {
  const q = fbQuery(fbCollection(db, 'customers'));
  return onSnapshot(q, (snapshot) => {
    const customers = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    }));
    callback(customers);
  });
}
