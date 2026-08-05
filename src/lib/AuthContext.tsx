import React, { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, User } from 'firebase/auth';
import { doc, onSnapshot, getDoc, setDoc, serverTimestamp, collection, getDocs, query, where } from 'firebase/firestore';
import { auth, db, googleProvider } from './firebase';

interface AuthContextType {
  user: User | null;
  role: string | null;
  roles: string[];
  userProfile: any | null;
  loading: boolean;
  isGuest: boolean;
  guestProjectCodes: string[];
  guestProjectCount: number;
  customerLoginError: string;
  onAnonymousReady: () => void;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  hasRole: (r: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [userProfile, setUserProfile] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [isGuest, setIsGuest] = useState(false);
  const [guestProjectCodes, setGuestProjectCodes] = useState<string[]>([]);
  const [guestProjectCount, setGuestProjectCount] = useState(0);
  const [customerLoginError, setCustomerLoginError] = useState('');
  const anonymousReadyRef = React.useRef<(() => void) | null>(null);

  const hasRole = (r: string) => roles.includes(r);

  useEffect(() => {
    let unsubscribeRole: (() => void) | undefined;

    // Xử lý redirect result từ signInWithRedirect
    getRedirectResult(auth).catch((err) => {
      console.warn('Redirect result error:', err);
    });

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      // Cleanup previous onSnapshot listener
      if (unsubscribeRole) {
        unsubscribeRole();
        unsubscribeRole = undefined;
      }
      setUser(user);
      if (user) {
        // Customer login via ID/PASS — skip users collection entirely
        if (user.isAnonymous) {
          // Retrieve stored credentials — check window first, then localStorage (F5)
          let creds = (window as any).__customerLogin as { loginId: string; loginPass: string; customerCode: string } | undefined;
          if (!creds) {
            const saved = localStorage.getItem('customerLogin');
            if (saved) {
              creds = JSON.parse(saved);
              (window as any).__customerLogin = creds;
            }
          }
          const customerCode = creds?.customerCode;

          if (!customerCode) {
            // LoginScreen is querying — register callback for when customerCode is ready
            anonymousReadyRef.current = async () => {
              const creds = (window as any).__customerLogin as { loginId: string; loginPass: string; customerCode: string } | undefined;
              const cc = creds?.customerCode;
              if (!cc) return;

              try {
                const customerDoc = await getDoc(doc(db, 'customers', cc));
                if (!customerDoc.exists()) {
                  delete (window as any).__customerLogin;
                  localStorage.removeItem('customerLogin');
                  await signOut(auth);
                  setLoading(false);
                  return;
                }
                const customerData = customerDoc.data();
                delete (window as any).__customerLogin;
                if (customerData.loginId !== creds.loginId || customerData.loginPass !== creds.loginPass) {
                  setCustomerLoginError('ID hoặc mật khẩu không đúng.');
                  localStorage.removeItem('customerLogin');
                  await signOut(auth);
                  setLoading(false);
                  return;
                }
                setCustomerLoginError('');
                setIsGuest(true);
                setRole('guest');
                setRoles(['guest']);
                let projectCodes: string[] = [];
                if (customerData.projects && Array.isArray(customerData.projects)) {
                  projectCodes = customerData.projects.flatMap((p: any) => [p.code, ...(p.subCodes || [])]);
                } else {
                  projectCodes = customerData.projectCodes || [];
                }
                setGuestProjectCodes(projectCodes);
                const pCount = Array.isArray(customerData.projects)
                  ? customerData.projects.reduce((s: number, p: any) => s + (p.subCodes?.length || 0), 0)
                  : projectCodes.length;
                setGuestProjectCount(pCount);
                setUserProfile({ ...customerData, uid: user.uid });
              } catch (err) {
                console.error('Error loading customer:', err);
                delete (window as any).__customerLogin;
                localStorage.removeItem('customerLogin');
              }
              setLoading(false);
            };
            return;
          }

          try {
            const customerDoc = await getDoc(doc(db, 'customers', customerCode));
            if (!customerDoc.exists()) {
              // Customer not found — sign out
              delete (window as any).__customerLogin;
              localStorage.removeItem('customerLogin');
              await signOut(auth);
              setLoading(false);
              return;
            }

            const customerData = customerDoc.data();

            // Verify loginId/loginPass if credentials were provided
            if (creds) {
              delete (window as any).__customerLogin;
              if (customerData.loginId !== creds.loginId || customerData.loginPass !== creds.loginPass) {
                // Wrong credentials — sign out and show error
                setCustomerLoginError('ID hoặc mật khẩu không đúng.');
                delete (window as any).__customerLogin;
                localStorage.removeItem('customerLogin');
                await signOut(auth);
                setLoading(false);
                return;
              }
            }

            // Credentials verified
            setCustomerLoginError('');
            setIsGuest(true);
            setRole('guest');
            setRoles(['guest']);

            let projectCodes: string[] = [];
            if (customerData.projects && Array.isArray(customerData.projects)) {
              projectCodes = customerData.projects.flatMap((p: any) => [p.code, ...(p.subCodes || [])]);
            } else {
              projectCodes = customerData.projectCodes || [];
            }
            setGuestProjectCodes(projectCodes);
            const pCount2 = Array.isArray(customerData.projects)
              ? customerData.projects.reduce((s: number, p: any) => s + (p.subCodes?.length || 0), 0)
              : projectCodes.length;
            setGuestProjectCount(pCount2);
            setUserProfile({ ...customerData, uid: user.uid });
          } catch (err) {
            console.error('Error loading customer:', err);
            delete (window as any).__customerLogin;
          }

          setLoading(false);
          return;
        }

        const userRef = doc(db, 'users', user.uid);

        try {
          const userDoc = await getDoc(userRef);
          const data = userDoc.data();
          const needsSync = !userDoc.exists() ||
            !data?.role ||
            !Array.isArray(data?.roles) ||
            data?.roles.length === 0;

          if (needsSync) {
            const existingRole = data?.role;
            const existingRoles = data?.roles;
            const resolvedRoles = Array.isArray(existingRoles) && existingRoles.length > 0
              ? existingRoles
              : existingRole
                ? [existingRole]
                : [user.email === 'nguyenkimqza@gmail.com' ? 'admin' : 'pending'];
            try {
              await setDoc(userRef, {
                uid: user.uid,
                displayName: user.displayName || 'User',
                email: user.email,
                photoURL: user.photoURL,
                ten_that: data?.ten_that || '',
                chuc_danh: data?.chuc_danh || 'Nhân viên',
                role: existingRole || resolvedRoles[0],
                roles: resolvedRoles,
                createdAt: data?.createdAt || serverTimestamp()
              }, { merge: true });
            } catch (syncErr) {
              console.warn("Could not sync user profile:", syncErr);
            }
          }
        } catch (error) {
          console.error("Error syncing user profile:", error);
        }

        // Check users first — nếu có role thì là user thường, bỏ qua guest check
        let isNormalUser = false;
        try {
          const userDocCheck = await getDoc(userRef);
          const userDataCheck = userDocCheck.data();
          if (userDocCheck.exists() && userDataCheck?.role && userDataCheck.role !== 'pending') {
            isNormalUser = true;
          }
        } catch {}

        if (isNormalUser) {
          // User thường — dùng onSnapshot listener
          setIsGuest(false);
          setGuestProjectCodes([]);

          unsubscribeRole = onSnapshot(userRef, (doc) => {
            const userData = doc.data();
            if (doc.exists() && (userData?.role || (Array.isArray(userData?.roles) && userData.roles.length > 0))) {
              setUserProfile(userData);
              setRole(userData.role);
              const resolvedRoles = Array.isArray(userData.roles) && userData.roles.length > 0
                ? userData.roles
                : [userData.role];
              setRoles(resolvedRoles);
            } else {
              setRole(null);
              setRoles([]);
            }
            setLoading(false);
          }, (error) => {
            console.error("Error fetching role:", error);
            setRole(null);
            setRoles([]);
            setLoading(false);
          });
        } else {
          // Chưa có trong users hoặc role pending — là guest
          setIsGuest(true);
          setRole('guest');
          setRoles(['guest']);

          // Lấy projectCodes từ customer theo customerCode
          let projectCodes: string[] = [];
          let pCount3 = 0;
          const savedCustomerCode = (window as any).__customerLogin?.customerCode;
          if (savedCustomerCode) {
            try {
              const customerDoc = await getDoc(doc(db, 'customers', savedCustomerCode));
              if (customerDoc.exists()) {
                const customerData = customerDoc.data();
                if (customerData.projects && Array.isArray(customerData.projects)) {
                  projectCodes = customerData.projects.flatMap((p: any) => [p.code, ...(p.subCodes || [])]);
                  pCount3 = customerData.projects.reduce((s: number, p: any) => s + (p.subCodes?.length || 0), 0);
                } else {
                  projectCodes = customerData.projectCodes || [];
                  pCount3 = projectCodes.length;
                }
                setUserProfile({ ...customerData, uid: user.uid });
              }
            } catch (err) {
              // Không tìm thấy customer — guest không có project restriction
            }
          }

          setGuestProjectCodes(projectCodes);
          setGuestProjectCount(pCount3);
          setLoading(false);
        }
      } else {
        setRole(null);
        setRoles([]);
        setIsGuest(false);
        setGuestProjectCodes([]);
        setLoading(false);
      }
    });

    return () => {
      unsubscribe();
      if (unsubscribeRole) unsubscribeRole();
    };
  }, []);

  const onAnonymousReady = () => {
    if (anonymousReadyRef.current) {
      anonymousReadyRef.current();
      anonymousReadyRef.current = null;
    }
  };

  const login = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      console.warn('Popup login failed:', error?.code);
      // Popup bị block hoặc đóng → fallback sang redirect
      if (
        error?.code === 'auth/popup-blocked' ||
        error?.code === 'auth/popup-closed-by-user' ||
        error?.code === 'auth/cancelled-popup-request' ||
        error?.code === 'auth/popup-closed-by-user'
      ) {
        try {
          await signInWithRedirect(auth, googleProvider);
        } catch (redirectError) {
          console.error('Login redirect failed:', redirectError);
        }
      } else {
        console.error('Login failed:', error);
      }
    }
  };

  const logout = async () => {
    try {
      setUserProfile(null);
      setRoles([]);
      setIsGuest(false);
      setGuestProjectCodes([]);
      setGuestProjectCount(0);
      localStorage.removeItem('customerLogin');
      delete (window as any).__customerLogin;
      await signOut(auth);
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, role, roles, userProfile, loading, isGuest, guestProjectCodes, guestProjectCount, customerLoginError, onAnonymousReady, login, logout, hasRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
