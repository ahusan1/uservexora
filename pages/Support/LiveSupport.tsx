import React, { useState, useEffect, useContext, useRef, useMemo } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { AuthContext } from '../../App.tsx';
import { supabase } from '../../lib/supabase.ts';
import { toast } from 'react-hot-toast';
import { getCurrentPath } from '../../lib/loginRedirect.ts';

const QUICK_ACTIONS = [
  { icon: 'fa-box', label: 'Order Status', query: 'I want to check the status of my recent purchase.' },
  { icon: 'fa-credit-card', label: 'Payment Issue', query: 'I am having trouble with my payment transaction.' },
  { icon: 'fa-cloud-arrow-down', label: 'Download Help', query: 'I am unable to download my purchased asset.' },
  { icon: 'fa-shield-halved', label: 'License Query', query: 'I have a question about the asset usage license.' }
];

const HELP_LINKS = [
  { label: 'Refund Policy', to: '/refund-policy' },
  { label: 'Asset Licensing', to: '/license' },
  { label: 'Account Security', to: '/profile' },
  { label: 'Terms of Service', to: '/terms' }
];

export const LiveSupport: React.FC = () => {
  const { user } = useContext(AuthContext);
  const navigate = useNavigate();
  const location = useLocation();
  const [messages, setMessages] = useState<any[]>([]);
  const [thread, setThread] = useState<any>(null);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [otherTyping, setOtherTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<any>(null);
  const channelRef = useRef<any>(null);

  useEffect(() => {
    if (!user) {
      navigate('/login', { state: { from: getCurrentPath(location) } });
      return;
    }

    let channel: any = null;

    const initChat = async () => {
      setLoading(true);
      try {
        // Get or create user's support thread
        const { data: existingThreads, error: fetchError } = await supabase
          .from('support_threads')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1);

        if (fetchError) {
          console.error('Fetch error:', fetchError);
          throw new Error('Failed to load support threads');
        }

        let threadData = existingThreads && existingThreads.length > 0 ? existingThreads[0] : null;

        if (!threadData) {
          const { data: newThread, error: createError } = await supabase
            .from('support_threads')
            .insert([{ user_id: user.id, status: 'open' }])
            .select()
            .single();
          if (createError) {
            console.error('Create error:', createError);
            throw new Error('Failed to create support thread');
          }
          threadData = newThread;
        }

        setThread(threadData);
        console.log('[LiveSupport] Thread loaded:', threadData.id);

        // Load existing messages
        const { data: msgData, error: msgError } = await supabase
          .from('support_messages')
          .select('*')
          .eq('thread_id', threadData.id)
          .order('created_at', { ascending: true });

        if (msgError) throw msgError;
        setMessages(msgData || []);
        console.log('[LiveSupport] Loaded messages:', msgData?.length || 0);

        // Subscribe to new messages
        channel = supabase.channel(`support_chat_${threadData.id}`, {
          config: { broadcast: { self: true } }
        })
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'support_messages',
              filter: `thread_id=eq.${threadData.id}`
            },
            (payload) => {
              console.log('[LiveSupport] New message received:', payload.new.id);
              setMessages(prev => {
                if (prev.some(m => m.id === payload.new.id)) return prev;
                return [...prev, payload.new];
              });
              setOtherTyping(false);
              window.dispatchEvent(new Event('support-unread-updated'));
            }
          )
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'support_messages',
              filter: `thread_id=eq.${threadData.id}`
            },
            (payload) => {
              setMessages(prev => {
                const exists = prev.some(m => m.id === payload.new.id);
                if (!exists) return [...prev, payload.new];
                return prev.map(m => (m.id === payload.new.id ? payload.new : m));
              });
              window.dispatchEvent(new Event('support-unread-updated'));
            }
          )
          .on('broadcast', { event: 'typing' }, (payload) => {
            if (payload.payload?.is_admin) {
              setOtherTyping(payload.payload.typing);
            }
          })
          .subscribe((status) => {
            console.log('[LiveSupport] Subscription status:', status);
          });
        channelRef.current = channel;
      } catch (err: any) {
        console.error('[LiveSupport] Init error:', err);
        toast.error(err.message || 'Failed to connect');
      } finally {
        setLoading(false);
      }
    };

    initChat();

    return () => {
      if (channel) {
        console.log('[LiveSupport] Unsubscribing from channel');
        supabase.removeChannel(channel);
      }
      channelRef.current = null;
    };
  }, [user, navigate]);

  useEffect(() => {
    if (!thread?.id || loading) return;

    const syncLatestMessages = async () => {
      try {
        const { data, error } = await supabase
          .from('support_messages')
          .select('*')
          .eq('thread_id', thread.id)
          .order('created_at', { ascending: true });

        if (error || !data) return;

        setMessages(prev => {
          if (data.length <= prev.length) return prev;
          return data;
        });
      } catch {
        // Silent fallback sync
      }
    };

    const interval = setInterval(syncLatestMessages, 2500);
    return () => clearInterval(interval);
  }, [thread?.id, loading]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, otherTyping]);

  const handleTyping = () => {
    if (!isTyping) {
      setIsTyping(true);
      channelRef.current?.send({
        type: 'broadcast',
        event: 'typing',
        payload: { typing: true, is_admin: false },
      });
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    
    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      channelRef.current?.send({
        type: 'broadcast',
        event: 'typing',
        payload: { typing: false, is_admin: false },
      });
    }, 2000);
  };

  const sendMessage = async (content: string) => {
    if (!content.trim() || !thread || sending) return;

    setSending(true);
    const trimmedContent = content.trim();
    
    try {
      console.log('[LiveSupport] Sending message to thread:', thread.id);
      
      // Optimistic update - show message immediately
      const tempMessage = {
        id: `temp-${Date.now()}`,
        thread_id: thread.id,
        sender_id: user?.id,
        content: trimmedContent,
        is_admin_reply: false,
        created_at: new Date().toISOString()
      };
      setMessages(prev => [...prev, tempMessage]);
      setNewMessage('');
      
      const { data, error } = await supabase
        .from('support_messages')
        .insert({
          thread_id: thread.id,
          sender_id: user?.id,
          content: trimmedContent,
          is_admin_reply: false
        })
        .select()
        .single();

      if (error) {
        console.error('[LiveSupport] Send error:', error);
        // Remove temp message on error
        setMessages(prev => prev.filter(m => m.id !== tempMessage.id));
        throw new Error(error.message || 'Failed to send message');
      }
      
      console.log('[LiveSupport] Message sent successfully:', data?.id);
      // Replace temp message with real one from DB
      setMessages(prev => prev.map(m => m.id === tempMessage.id ? data : m));
      setIsTyping(false);
      toast.success('Message sent!');
    } catch (err: any) {
      console.error('[LiveSupport] Message send error:', err);
      toast.error(err.message || 'Message failed to send');
    } finally {
      setSending(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#f8fafc]">
      <div className="w-12 h-12 border-4 border-[#2874f0]/20 border-t-[#2874f0] rounded-full animate-spin mb-4"></div>
      <p className="text-[9px] font-black uppercase tracking-[0.3em] text-gray-400 italic">Syncing Session...</p>
    </div>
  );

  return (
    <div className="bg-[#f1f3f6] flex-grow flex flex-col overflow-hidden">
      <div className="max-w-[1600px] w-full mx-auto flex-grow flex flex-col md:flex-row md:p-6 gap-6 overflow-hidden">
        
        {/* Main Consultation Window */}
        <div className="flex-grow flex flex-col bg-white md:rounded-[2.5rem] shadow-xl border border-gray-100 overflow-hidden relative h-full">
          
          {/* Condensed Glassmorphic Header */}
          <div className="bg-white/95 backdrop-blur-md border-b border-gray-100 p-4 md:p-6 flex items-center justify-between sticky top-0 z-30 shrink-0">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className="w-10 h-10 md:w-12 md:h-12 bg-indigo-600 rounded-xl flex items-center justify-center text-white text-lg shadow-lg">
                  <i className="fas fa-headset"></i>
                </div>
                <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-500 border-2 border-white rounded-full"></div>
              </div>
              <div>
                <h1 className="text-sm md:text-base font-black text-gray-900 leading-none italic tracking-tight flex items-center gap-2">
                  Concierge Desk
                </h1>
                <div className="flex items-center gap-1.5 mt-1">
                   <span className="text-[8px] font-black text-emerald-500 uppercase tracking-widest flex items-center gap-1">
                     <span className="w-1 h-1 bg-emerald-500 rounded-full animate-pulse"></span>
                     Live Connection
                   </span>
                </div>
              </div>
            </div>
            <button 
              onClick={() => navigate('/')}
              className="text-[10px] font-black uppercase text-gray-400 hover:text-blue-600 tracking-widest md:hidden"
            >
              Exit
            </button>
          </div>

          {/* Message List Area */}
          <div 
            ref={scrollRef}
            className="flex-grow overflow-y-auto p-4 md:p-8 space-y-1.5 bg-gray-50/20 custom-scrollbar scroll-smooth relative"
          >
            {/* Security Notice */}
            <div className="flex justify-center mb-6">
               <div className="bg-blue-50/50 border border-blue-100/30 px-4 py-1.5 rounded-xl flex items-center gap-2">
                  <i className="fas fa-lock text-[#2874f0] text-[8px]"></i>
                  <span className="text-[8px] font-black text-[#2874f0] uppercase tracking-widest">Secure Terminal Active</span>
               </div>
            </div>

            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[80%] text-center max-w-sm mx-auto animate-in fade-in zoom-in-95">
                <div className="w-24 h-24 bg-gray-50 text-blue-500 rounded-2xl flex items-center justify-center text-4xl mb-6 shadow-inner">
                  <i className="fas fa-comments-alt"></i>
                </div>
                <h3 className="text-xl font-black text-gray-900 tracking-tight italic">Welcome, {user.name.split(' ')[0]}</h3>
                <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-2 mb-8">How can we assist you today?</p>
                
                <div className="grid grid-cols-1 gap-2 w-full">
                  {QUICK_ACTIONS.map((action, i) => (
                    <button
                      key={i}
                      onClick={() => sendMessage(action.query)}
                      className="p-3 bg-white border border-gray-100 rounded-xl hover:border-blue-500 hover:bg-blue-50 transition-all text-left flex items-center gap-3 group"
                    >
                      <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center group-hover:bg-white shrink-0">
                        <i className={`fas ${action.icon} text-gray-400 group-hover:text-blue-500 text-xs`}></i>
                      </div>
                      <span className="text-[9px] font-black text-gray-600 uppercase tracking-widest">{action.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                {messages.map((msg, idx) => {
                  const isMe = !msg.is_admin_reply;
                  const prevMsg = messages[idx - 1];
                  const isFirstInGroup = !prevMsg || prevMsg.is_admin_reply !== msg.is_admin_reply;

                  return (
                    <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} ${isFirstInGroup ? 'mt-4' : 'mt-0.5'}`}>
                      {!isMe && isFirstInGroup && (
                        <p className="text-[8px] font-black uppercase tracking-widest text-blue-500 mb-1 ml-1">Marketplace Specialist</p>
                      )}
                      <div className={`max-w-[85%] md:max-w-[70%] px-4 py-2.5 shadow-sm ${
                        isMe 
                          ? 'bg-blue-600 text-white' 
                          : 'bg-white text-gray-800 border border-gray-100'
                      } ${
                        isMe 
                          ? 'rounded-l-2xl rounded-t-2xl'
                          : 'rounded-r-2xl rounded-t-2xl'
                      }`}>
                        <p className="text-sm font-medium leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                        <div className={`flex items-center gap-1.5 mt-1.5 opacity-30 ${isMe ? 'justify-end' : 'justify-start'}`}>
                          <p className="text-[7px] font-black uppercase tracking-widest">
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {otherTyping && (
              <div className="flex items-start gap-3 mt-4 animate-in fade-in slide-in-from-bottom-2">
                <div className="bg-white border border-gray-100 rounded-xl px-4 py-2 shadow-sm italic text-[8px] text-gray-400 font-black uppercase tracking-widest flex items-center gap-3">
                  Specialist typing
                  <div className="flex gap-1">
                    <span className="w-1 h-1 bg-blue-500 rounded-full animate-bounce"></span>
                    <span className="w-1 h-1 bg-blue-500 rounded-full animate-bounce [animation-delay:0.2s]"></span>
                    <span className="w-1 h-1 bg-blue-500 rounded-full animate-bounce [animation-delay:0.4s]"></span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Secure Input Dock */}
          <div className="p-3 md:p-6 bg-white border-t border-gray-50 shrink-0">
            <form onSubmit={(e) => { e.preventDefault(); sendMessage(newMessage); }} className="flex items-center gap-2 md:gap-4">
              <div className="flex-grow relative">
                <input 
                  type="text" 
                  value={newMessage}
                  onKeyDown={handleTyping}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Input message..."
                  className="w-full pl-4 pr-10 py-3 bg-gray-50 border border-transparent rounded-xl focus:bg-white focus:border-blue-500 outline-none font-medium transition-all text-xs"
                />
              </div>
              <button 
                type="submit"
                disabled={sending || !newMessage.trim()}
                className="w-12 h-12 md:w-14 md:h-14 bg-gray-900 text-white rounded-xl flex items-center justify-center shadow-lg active:scale-95 disabled:opacity-20 transition-all shrink-0"
              >
                {sending ? <i className="fas fa-circle-notch fa-spin"></i> : <i className="fas fa-paper-plane"></i>}
              </button>
            </form>
          </div>
        </div>

        {/* Right Helpdeck Sidebar (Desktop Only) */}
        <div className="hidden lg:flex flex-col w-[300px] gap-4">
          
          <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
             <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-6">User Identity</p>
             <div className="flex items-center gap-4 mb-6">
                <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center font-black text-blue-600">
                  {user.name.charAt(0)}
                </div>
                <div className="min-w-0">
                   <p className="font-black text-gray-900 text-sm truncate">{user.name}</p>
                   <p className="text-[8px] font-black text-emerald-500 uppercase tracking-widest mt-1">Verified Client</p>
                </div>
             </div>
             <div className="space-y-2">
                <div className="flex justify-between items-center p-3 bg-gray-50 rounded-xl">
                   <span className="text-[9px] font-bold text-gray-400 uppercase">Trust Level</span>
                   <span className="text-[9px] font-black text-blue-600 uppercase">Elite</span>
                </div>
             </div>
          </div>

          <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex-grow">
             <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-6">Help Resources</p>
             <div className="space-y-2">
                {HELP_LINKS.map((link, idx) => (
                  <Link 
                    key={idx} 
                    to={link.to} 
                    className="flex items-center justify-between p-3 bg-gray-50/50 hover:bg-blue-50 rounded-xl transition-all group"
                  >
                    <span className="text-[10px] font-black text-gray-600 uppercase tracking-tighter">{link.label}</span>
                    <i className="fas fa-chevron-right text-[8px] text-gray-300 group-hover:text-blue-500"></i>
                  </Link>
                ))}
             </div>
          </div>

          <div className="bg-indigo-600 rounded-3xl p-5 text-white text-center">
             <p className="text-[9px] font-black uppercase tracking-widest mb-1">Privacy Guarantee</p>
             <p className="text-[10px] font-medium opacity-80 leading-relaxed italic">Encrypted Connection</p>
          </div>

        </div>
      </div>
      
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 20px; }
      `}</style>
    </div>
  );
};
