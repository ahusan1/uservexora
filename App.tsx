import React, { useState, useEffect, useCallback, createContext, useContext, Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link as RouterLink, useLocation } from 'react-router-dom';
import { toast, Toaster } from 'react-hot-toast';
import { ScrollRestoration } from './components/ScrollRestoration.tsx';
import { Navbar } from './components/Navbar.tsx';
import { UserProfile, Product } from './types.ts';
import { supabase, robustFetch, checkDbHealth } from './lib/supabase.ts';
import { getCachedSettingBoolean } from './lib/settingsCache.ts';

import { clearPendingResumeAction } from './lib/loginRedirect.ts';

const Sidebar = lazy(() => import('./components/Sidebar.tsx').then((m) => ({ default: m.Sidebar })));
const LogoutModal = lazy(() => import('./components/LogoutModal.tsx').then((m) => ({ default: m.LogoutModal })));

const Home = lazy(() => import('./pages/Home.tsx').then((m) => ({ default: m.Home })));
const ProductDetails = lazy(() => import('./pages/ProductDetails.tsx').then((m) => ({ default: m.ProductDetails })));
const Login = lazy(() => import('./pages/Login.tsx').then((m) => ({ default: m.Login })));
const Signup = lazy(() => import('./pages/Signup.tsx').then((m) => ({ default: m.Signup })));
const Dashboard = lazy(() => import('./pages/Dashboard.tsx').then((m) => ({ default: m.Dashboard })));
const Cart = lazy(() => import('./pages/Cart.tsx').then((m) => ({ default: m.Cart })));
const Wishlist = lazy(() => import('./pages/Wishlist.tsx').then((m) => ({ default: m.Wishlist })));
const Profile = lazy(() => import('./pages/Profile.tsx').then((m) => ({ default: m.Profile })));
const Search = lazy(() => import('./pages/Search.tsx').then((m) => ({ default: m.Search })));

const Terms = lazy(() => import('./pages/Policies/Terms.tsx').then((m) => ({ default: m.Terms })));
const Privacy = lazy(() => import('./pages/Policies/Privacy.tsx').then((m) => ({ default: m.Privacy })));
const RefundPolicy = lazy(() => import('./pages/Policies/Refund.tsx').then((m) => ({ default: m.RefundPolicy })));
const License = lazy(() => import('./pages/Policies/License.tsx').then((m) => ({ default: m.License })));
const LiveSupport = lazy(() => import('./pages/Support/LiveSupport.tsx').then((m) => ({ default: m.LiveSupport })));

interface CartItem extends Product {
  quantity: number;
}

export const AuthContext = createContext<{
  user: UserProfile | null;
  setUser: (user: UserProfile | null) => void;
  loading: boolean;
  downloadLimitsEnabled: boolean;
  isOnline: boolean;
  cart: CartItem[];
  wishlist: Product[];
  purchasedProductIds: Set<string>;
  purchasedOrders: Record<string, any>;
  addToCart: (product: Product) => void;
  removeFromCart: (productId: string) => void;
  clearCart: () => void;
  isInCart: (productId: string) => boolean;
  isPurchased: (productId: string) => boolean;
  toggleWishlist: (product: Product) => Promise<void>;
  isInWishlist: (productId: string) => boolean;
  logout: () => Promise<void>;
  confirmLogout: () => void;
  fetchProfileWithRetry: (userId: string, retries?: number) => Promise<UserProfile | null>;
  refreshPurchases: () => Promise<void>;
}>({ 
  user: null, 
  setUser: () => {}, 
  loading: true,
  downloadLimitsEnabled: true,
  isOnline: true,
  cart: [],
  wishlist: [],
  purchasedProductIds: new Set(),
  purchasedOrders: {},
  addToCart: () => {},
  removeFromCart: () => {},
  clearCart: () => {},
  isInCart: () => false,
  isPurchased: () => false,
  toggleWishlist: async () => {},
  isInWishlist: () => false,
  logout: async () => {},
  confirmLogout: () => {},
  fetchProfileWithRetry: async () => null,
  refreshPurchases: async () => {}
});

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, loading } = useContext(AuthContext);
  const location = useLocation();
  
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <i className="fas fa-circle-notch fa-spin text-4xl text-[#2874f0]"></i>
    </div>
  );
  
  if (!user) {
    const from = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to="/login" state={{ from }} replace />;
  }
  return <>{children}</>;
};

const GuestRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, loading, setUser } = useContext(AuthContext);
  const location = useLocation();
  const [hasValidSession, setHasValidSession] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;

    const verifySession = async () => {
      if (!user) {
        if (active) setHasValidSession(false);
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      const valid = Boolean(session?.user?.id && session.user.id === user.id);

      if (!active) return;
      setHasValidSession(valid);

      if (!valid) {
        setUser(null);
      }
    };

    setHasValidSession(null);
    verifySession();

    return () => {
      active = false;
    };
  }, [user, setUser]);

  if (loading || (user && hasValidSession === null)) return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <i className="fas fa-circle-notch fa-spin text-4xl text-[#2874f0]"></i>
    </div>
  );

  if (user && hasValidSession) {
    const from = (location.state as { from?: string } | null)?.from;
    const redirectTo = from && from.startsWith('/') && !from.startsWith('/login') && !from.startsWith('/signup') ? from : '/';
    return <Navigate to={redirectTo} replace />;
  }

  return <>{children}</>;
};

const AppLayout: React.FC<{
  isOnline: boolean;
  init: () => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  logoutModalOpen: boolean;
  setLogoutModalOpen: (open: boolean) => void;
  logout: () => void;
}> = ({ isOnline, init, sidebarOpen, setSidebarOpen, logoutModalOpen, setLogoutModalOpen, logout }) => {
  const location = useLocation();
  const hideFooterOn = ['/support', '/search'];
  const showFooter = !hideFooterOn.some(path => location.pathname === path);

  return (
    <div className="min-h-screen flex flex-col font-sans">
      {!isOnline && (
        <div className="bg-red-600 text-white py-1.5 px-4 text-[10px] font-black uppercase tracking-[0.2em] text-center sticky top-0 z-[200] flex items-center justify-center gap-3">
           <i className="fas fa-wifi-slash animate-pulse"></i>
           Searching for server signal...
           <button onClick={init} className="underline ml-2 hover:text-white/80">Try Now</button>
        </div>
      )}
      <Navbar onMenuClick={() => setSidebarOpen(true)} />
      <Suspense fallback={null}>
        <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      </Suspense>
      <Suspense fallback={null}>
        <LogoutModal 
          isOpen={logoutModalOpen} 
          onConfirm={logout} 
          onCancel={() => setLogoutModalOpen(false)} 
        />
      </Suspense>
      
      <main className="flex-grow flex flex-col pt-14 md:pt-16">
        <Suspense fallback={
          <div className="min-h-[40vh] flex items-center justify-center bg-white">
            <i className="fas fa-circle-notch fa-spin text-3xl text-[#2874f0]"></i>
          </div>
        }>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/product/:id" element={<ProductDetails />} />
          <Route path="/login" element={<GuestRoute><Login /></GuestRoute>} />
          <Route path="/signup" element={<GuestRoute><Signup /></GuestRoute>} />
          <Route path="/cart" element={<Cart />} />
          <Route path="/search" element={<Search />} />
          <Route path="/wishlist" element={<ProtectedRoute><Wishlist /></ProtectedRoute>} />
          <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
          <Route path="/support" element={<ProtectedRoute><LiveSupport /></ProtectedRoute>} />
          
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/refund-policy" element={<RefundPolicy />} />
          <Route path="/license" element={<License />} />
          
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </main>

      {showFooter && (
        <footer className="bg-[#172337] text-gray-400 py-16 px-8 relative overflow-hidden">
          {!isOnline && <div className="absolute inset-0 bg-black/10 backdrop-grayscale pointer-events-none"></div>}
          <div className="max-w-7xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-12">
            
            <div className="space-y-4">
              <p className="text-white text-xs font-black uppercase tracking-[0.2em] mb-6">Marketplace</p>
              <RouterLink to="/" className="block text-xs hover:text-white transition-colors">Catalog Home</RouterLink>
              <RouterLink to="/cart" className="block text-xs hover:text-white transition-colors">My Cart</RouterLink>
              <RouterLink to="/dashboard" className="block text-xs hover:text-white transition-colors">My Orders</RouterLink>
            </div>

            <div className="space-y-4">
              <p className="text-white text-xs font-black uppercase tracking-[0.2em] mb-6">Support</p>
              <RouterLink to="/support" className="block text-xs hover:text-white transition-colors">Live Cast Support</RouterLink>
              <p className="text-[10px] text-emerald-500 font-bold flex items-center gap-2">
                 <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-red-500'} animate-pulse`}></span>
                 DB System {isOnline ? 'Online' : 'Offline'}
              </p>
            </div>

            <div className="space-y-4">
              <p className="text-white text-xs font-black uppercase tracking-[0.2em] mb-6">Policy</p>
              <RouterLink to="/terms" className="block text-xs hover:text-white transition-colors">Terms of Use</RouterLink>
              <RouterLink to="/privacy" className="block text-xs hover:text-white transition-colors">Privacy Policy</RouterLink>
              <RouterLink to="/refund-policy" className="block text-xs hover:text-white transition-colors">Refund & Cancellation</RouterLink>
              <RouterLink to="/license" className="block text-xs hover:text-white transition-colors">Asset License</RouterLink>
            </div>

            <div className="space-y-4">
              <p className="text-white text-xs font-black uppercase tracking-[0.2em] mb-6">Connect</p>
              <p className="text-xs hover:text-white cursor-pointer transition-colors flex items-center gap-2">
                <i className="fab fa-twitter"></i> Twitter
              </p>
              <p className="text-xs hover:text-white cursor-pointer transition-colors flex items-center gap-2">
                <i className="fab fa-linkedin"></i> LinkedIn
              </p>
            </div>

          </div>
          <div className="max-w-7xl mx-auto mt-16 pt-8 border-t border-gray-800 flex flex-col md:flex-row items-center justify-between text-[11px] gap-6">
             <p>© 2024 Vexora Global.</p>
             <div className="flex gap-6 grayscale opacity-30">
                <i className="fab fa-cc-visa text-xl"></i>
                <i className="fab fa-cc-mastercard text-xl"></i>
                <i className="fab fa-cc-paypal text-xl"></i>
             </div>
          </div>
        </footer>
      )}
      
      <Toaster position="bottom-center" toastOptions={{
        style: { 
          background: '#1e293b', 
          color: '#fff', 
          fontSize: '12px', 
          fontWeight: '900', 
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          borderRadius: '12px',
          padding: '12px 24px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.2)'
        },
      }} />
    </div>
  );
};

const App: React.FC = () => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloadLimitsEnabled, setDownloadLimitsEnabled] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [logoutModalOpen, setLogoutModalOpen] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [wishlist, setWishlist] = useState<Product[]>([]);
  const [purchasedProductIds, setPurchasedProductIds] = useState<Set<string>>(new Set());
  const [purchasedOrders, setPurchasedOrders] = useState<Record<string, any>>({});

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const idleApi = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, opts?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    const prefetchRoutes = () => {
      if (cancelled) return;

      const connection = navigator.connection as (NetworkInformation & {
        saveData?: boolean;
      }) | undefined;
      const shouldAvoidPrefetch = Boolean(
        connection?.saveData ||
        connection?.effectiveType === 'slow-2g' ||
        connection?.effectiveType === '2g'
      );

      if (shouldAvoidPrefetch || document.visibilityState !== 'visible') {
        return;
      }

      void import('./pages/Search.tsx');
      void import('./pages/ProductDetails.tsx');
    };

    const schedulePrefetch = () => {
      if (idleApi.requestIdleCallback && idleApi.cancelIdleCallback) {
        const idleId = idleApi.requestIdleCallback(prefetchRoutes, { timeout: 8000 });
        return () => idleApi.cancelIdleCallback?.(idleId);
      }

      timeoutId = setTimeout(prefetchRoutes, 4500);
      return () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };
    };

    let cancelScheduled = () => {};

    if (document.readyState === 'complete') {
      cancelScheduled = schedulePrefetch();
    } else {
      const onLoad = () => {
        window.removeEventListener('load', onLoad);
        cancelScheduled = schedulePrefetch();
      };
      window.addEventListener('load', onLoad, { once: true });
      cancelScheduled = () => window.removeEventListener('load', onLoad);
    }

    return () => {
      cancelled = true;
      cancelScheduled();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      toast.success('Connection Restored', { icon: '🌐' });
    };
    const handleOffline = () => {
      setIsOnline(false);
      toast.error('Working Offline', { icon: '📡' });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const interval = setInterval(async () => {
      const healthy = await checkDbHealth();
      if (!healthy && isOnline) {
        setIsOnline(false);
      } else if (healthy && !isOnline) {
        setIsOnline(true);
      }
    }, 30000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, [isOnline]);

  useEffect(() => {
    const savedCart = localStorage.getItem('dm_cart');
    if (savedCart) setCart(JSON.parse(savedCart));
  }, []);

  useEffect(() => {
    localStorage.setItem('dm_cart', JSON.stringify(cart));
  }, [cart]);

  const addToCart = useCallback((product: Product) => {
    if (purchasedProductIds.has(product.id)) {
      toast('You already own this product', { icon: '✅' });
      return;
    }
    setCart(prev => {
      if (prev.some(item => item.id === product.id)) {
        toast('Already in cart', { icon: 'ℹ️' });
        return prev;
      }
      toast.success('Added to Cart');
      return [...prev, { ...product, quantity: 1 }];
    });
  }, [purchasedProductIds]);

  const isInCart = useCallback((productId: string) => cart.some(item => item.id === productId), [cart]);
  const isPurchased = useCallback((productId: string) => purchasedProductIds.has(productId), [purchasedProductIds]);

  const removeFromCart = (productId: string) => {
    setCart(prev => prev.filter(item => item.id !== productId));
    toast.success('Removed from Cart');
  };

  const clearCart = () => setCart([]);

  const refreshPurchases = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) {
      setPurchasedProductIds(new Set());
      setPurchasedOrders({});
      return;
    }
    
    try {
      const { data, error } = await robustFetch<any[]>(
        supabase
          .from('orders')
          .select('id,user_id,product_id,payment_id,status,created_at,unit_price,final_price,discount_amount,coupon_code,license_active,download_limit,download_count,payout_status,seller_earnings')
          .eq('user_id', userId)
          .eq('status', 'paid')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
      );
      
      if (!error && data) {
        const ids = new Set<string>();
        const ordersMap: Record<string, any> = {};
        data.forEach(o => {
          ids.add(o.product_id);
          if (!ordersMap[o.product_id]) ordersMap[o.product_id] = o;
        });
        setPurchasedProductIds(ids);
        setPurchasedOrders(ordersMap);
      }
    } catch (e) {
      console.error("Failed to fetch purchases", e);
    }
  }, []);

  const fetchWishlist = useCallback(async (userId: string) => {
    try {
      const { data, error } = await robustFetch<any[]>(
        supabase.from('wishlist').select('products (*)').eq('user_id', userId)
      );
      
      if (!error && data) {
        setWishlist(data.map((item: any) => item.products).filter(Boolean));
      }
    } catch (e) {
      console.error("Failed to fetch wishlist", e);
    }
  }, []);

  const toggleWishlist = async (product: Product) => {
    if (!user) {
      toast.error('Please login first');
      return;
    }

    const isWishlisted = wishlist.some(item => item.id === product.id);
    if (isWishlisted) {
      const { error } = await robustFetch(
        supabase.from('wishlist').delete().eq('user_id', user.id).eq('product_id', product.id)
      );
      if (!error) {
        setWishlist(prev => prev.filter(item => item.id !== product.id));
        toast.success('Removed from Wishlist');
      }
    } else {
      const { error } = await robustFetch(
        supabase.from('wishlist').insert({ user_id: user.id, product_id: product.id })
      );
      if (!error) {
        setWishlist(prev => [...prev, product]);
        toast.success('Added to Wishlist');
      }
    }
  };

  const isInWishlist = (productId: string) => wishlist.some(item => item.id === productId);

  const fetchProfileWithRetry = useCallback(async (userId: string, retries = 5): Promise<UserProfile | null> => {
    const { data } = await robustFetch<UserProfile>(
      supabase.from('users').select('*').eq('id', userId).maybeSingle(),
      retries
    );
    return data;
  }, []);

  const logout = async () => {
    try {
      await supabase.auth.signOut();
      setUser(null);
      setWishlist([]);
      setPurchasedProductIds(new Set());
      setPurchasedOrders({});
      setLogoutModalOpen(false);
      toast.success('Logged out successfully');
    } catch (err: any) {
      toast.error('Logout failed');
    }
  };

  const confirmLogout = () => setLogoutModalOpen(true);

  const init = useCallback(async () => {
    setLoading(true);
    const globalLimitEnabled = await getCachedSettingBoolean('download_limit_enabled', true, 60);
    setDownloadLimitsEnabled(globalLimitEnabled);

    const { data: { session } } = await supabase.auth.getSession();
    
    if (session?.user) {
      const profile = await fetchProfileWithRetry(session.user.id);
      if (profile) {
        setUser(prev => (prev?.id !== profile.id ? profile : prev));
        fetchWishlist(session.user.id);
        refreshPurchases();
      }
    } else {
      setUser(null);
      clearPendingResumeAction();
    }
    setLoading(false);
  }, [fetchProfileWithRetry, fetchWishlist, refreshPurchases]);

  useEffect(() => {
    let mounted = true;
    init();

    const handleAuthError = async () => {
      if (mounted) {
        toast.error('Session expired or invalid. Please log in again.');
        await supabase.auth.signOut();
        setUser(null);
        setWishlist([]);
        setPurchasedProductIds(new Set());
        setPurchasedOrders({});
        clearPendingResumeAction();
      }
    };
    window.addEventListener('auth-error', handleAuthError);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return;

      if (event === 'SIGNED_OUT' || (event as any) === 'USER_DELETED') {
        setUser(null);
        setWishlist([]);
        setPurchasedProductIds(new Set());
        setPurchasedOrders({});
        clearPendingResumeAction();
      } else if (event === 'TOKEN_REFRESHED') {
        console.log('Session token refreshed securely by Supabase.');
      } else if (session?.user) {
        setUser(prevUser => {
          if (!prevUser || prevUser.id !== session.user.id) {
             fetchProfileWithRetry(session.user.id).then(profile => {
                if (profile && mounted) {
                  setUser(profile);
                  fetchWishlist(session.user.id);
                  refreshPurchases();
                }
             });
          }
          return prevUser;
        });
      }
    });

    return () => {
      mounted = false;
      window.removeEventListener('auth-error', handleAuthError);
      subscription.unsubscribe();
    };
  }, [init, fetchProfileWithRetry, fetchWishlist, refreshPurchases]);

  return (
    <AuthContext.Provider value={{ 
      user, setUser, loading, downloadLimitsEnabled, isOnline, cart, wishlist, purchasedProductIds, purchasedOrders, addToCart, removeFromCart, clearCart, isInCart, isPurchased, toggleWishlist, isInWishlist, logout, confirmLogout, fetchProfileWithRetry, refreshPurchases 
    }}>
      <BrowserRouter>
        <ScrollRestoration />
        <AppLayout 
          isOnline={isOnline}
          init={init}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          logoutModalOpen={logoutModalOpen}
          setLogoutModalOpen={setLogoutModalOpen}
          logout={logout}
        />
      </BrowserRouter>
    </AuthContext.Provider>
  );
};

export default App;
