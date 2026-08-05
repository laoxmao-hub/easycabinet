import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
 Send, Search, AtSign, Users, MessageSquare, Clock, X, Check, ShieldAlert,
 Lock, MessageCircle, ArrowLeft, User
} from 'lucide-react';
import {
 collection, query, orderBy, onSnapshot, addDoc, serverTimestamp, updateDoc, doc, limit, where
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, cleanUndefinedFields } from '../lib/firebase';
import { useAuth } from '../lib/AuthContext';
import { ChatMessage, UserProfile, PrivateMessage } from '../types';

interface ExchangeScreenProps {
 allUsers: UserProfile[];
}

export function ExchangeScreen({ allUsers }: ExchangeScreenProps) {
 const { user, userProfile } = useAuth();
 
 // Tab chính: chat nhóm ('group') hoặc chat riêng ('private')
 const [chatType, setChatType] = useState<'group' | 'private'>('group');
 
 // Tin nhắn nhóm
 const [messages, setMessages] = useState<ChatMessage[]>([]);
 const [loading, setLoading] = useState(true);
 const [searchText, setSearchText] = useState('');
 
 // Tin nhắn riêng
 const [selectedPrivateUser, setSelectedPrivateUser] = useState<UserProfile | null>(null);
 const [privateMessages, setPrivateMessages] = useState<PrivateMessage[]>([]);
 const [loadingPrivate, setLoadingPrivate] = useState(false);
 const [unreadPrivateCounts, setUnreadPrivateCounts] = useState<Record<string, number>>({});
 
 // Input chat state
 const [inputText, setInputText] = useState('');
 const [showMentionSuggestions, setShowMentionSuggestions] = useState(false);
 const [mentionQuery, setMentionQuery] = useState('');
 const [mentionStartIndex, setMentionStartIndex] = useState(-1);
 const [selectedMentionUids, setSelectedMentionUids] = useState<string[]>([]);
 
 const messagesEndRef = useRef<HTMLDivElement>(null);
 const privateMessagesEndRef = useRef<HTMLDivElement>(null);
 const textareaRef = useRef<HTMLTextAreaElement>(null);

 // Scroll to bottom helper
 const scrollToBottom = () => {
 if (chatType === 'group') {
 messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
 } else {
 privateMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
 }
 };

 // 1. Sắp xếp an toàn ở client để tin nhắn vừa gửi bằng serverTimestamp() chưa đồng bộ (bằng null) không bị nhảy lên đầu
 useEffect(() => {
 const q = query(
 collection(db, 'messages'),
 orderBy('createdAt', 'asc')
 );

 const unsubscribe = onSnapshot(q, (snapshot) => {
 const msgs = snapshot.docs.map(doc => ({
 id: doc.id,
 ...doc.data()
 })) as ChatMessage[];
 
 // Sắp xếp an toàn ở client để các tin nhắn mới tạo trôi xuống dưới cùng (cho dù createdAt tạm thời bằng null)
 msgs.sort((a, b) => {
 const timeA = a.createdAt ? (a.createdAt.toDate ? a.createdAt.toDate().getTime() : new Date(a.createdAt).getTime()) : Date.now();
 const timeB = b.createdAt ? (b.createdAt.toDate ? b.createdAt.toDate().getTime() : new Date(b.createdAt).getTime()) : Date.now();
 return timeA - timeB;
 });

 setMessages(msgs);
 setLoading(false);
 setTimeout(scrollToBottom, 50);
 }, (error) => {
 console.error("Error loading chat messages:", error);
 handleFirestoreError(error, OperationType.LIST, 'messages');
 setLoading(false);
 });

 return unsubscribe;
 }, []);

 // 2. Lắng nghe tin nhắn riêng giữa tôi và user được chọn
 useEffect(() => {
 if (!user || chatType !== 'private' || !selectedPrivateUser) return;
 setLoadingPrivate(true);
 setPrivateMessages([]);
 
 // Nạp tin nhắn riêng liên quan đến tôi và user đối tác
 const qSent = query(
 collection(db, 'private_messages'),
 where('senderId', '==', user.uid),
 where('receiverId', '==', selectedPrivateUser.uid)
 );
 
 const qReceived = query(
 collection(db, 'private_messages'),
 where('senderId', '==', selectedPrivateUser.uid),
 where('receiverId', '==', user.uid)
 );

 let sentMsgs: PrivateMessage[] = [];
 let receivedMsgs: PrivateMessage[] = [];

 const updatePrivateMessages = () => {
 const combined = [...sentMsgs, ...receivedMsgs];
 // Sắp xếp theo thứ tự thời gian tăng dần
 combined.sort((a, b) => {
 const timeA = a.createdAt ? (a.createdAt.toDate ? a.createdAt.toDate().getTime() : new Date(a.createdAt).getTime()) : Date.now();
 const timeB = b.createdAt ? (b.createdAt.toDate ? b.createdAt.toDate().getTime() : new Date(b.createdAt).getTime()) : Date.now();
 return timeA - timeB;
 });
 setPrivateMessages(combined);
 setLoadingPrivate(false);
 setTimeout(scrollToBottom, 50);
 };

 const unsubSent = onSnapshot(qSent, (snap) => {
 sentMsgs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as PrivateMessage));
 updatePrivateMessages();
 }, (err) => {
 console.warn("Lỗi nạp tin nhắn gửi:", err);
 setLoadingPrivate(false);
 });

 const unsubReceived = onSnapshot(qReceived, (snap) => {
 receivedMsgs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as PrivateMessage));
 updatePrivateMessages();
 }, (err) => {
 console.warn("Lỗi nạp tin nhắn nhận:", err);
 setLoadingPrivate(false);
 });

 // Reset bộ đếm tin chưa đọc của user này khi đã mở chat riêng
 setUnreadPrivateCounts(prev => {
 const clone = { ...prev };
 delete clone[selectedPrivateUser.uid];
 return clone;
 });

 return () => {
 unsubSent();
 unsubReceived();
 };
 }, [user, chatType, selectedPrivateUser]);

 // 3. Lắng nghe toàn bộ tin nhắn riêng gửi cho tôi để đếm tin chưa đọc trong thời gian thực
 useEffect(() => {
 if (!user) return;
 
 const qAllReceived = query(
 collection(db, 'private_messages'),
 where('receiverId', '==', user.uid)
 );

 const unsubscribe = onSnapshot(qAllReceived, (snapshot) => {
 const counts: Record<string, number> = {};
 const lastReadSessionTime = Number(localStorage.getItem(`draco_pm_last_read_${user.uid}`) || '0');

 snapshot.docs.forEach(doc => {
 const data = doc.data() as PrivateMessage;
 const msgTime = data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().getTime() : new Date(data.createdAt).getTime()) : Date.now();
 
 // Nếu tin nhắn riêng này chưa được đọc (và k hoạt động trong khung chat với sender này)
 const isNotActiveSession = !selectedPrivateUser || selectedPrivateUser.uid !== data.senderId || chatType !== 'private';
 
 if (msgTime > lastReadSessionTime && isNotActiveSession) {
 counts[data.senderId] = (counts[data.senderId] || 0) + 1;
 }
 });
 setUnreadPrivateCounts(counts);
 }, (error) => {
 console.warn("Lỗi đồng bộ đếm tin nhắn riêng:", error);
 });

 return unsubscribe;
 }, [user, selectedPrivateUser, chatType]);

 // 4. Định nghĩa hàm kiểm tra Người dùng có đang hoạt động (Online) hay không
 // (Nếu lastActive được cập nhật trong vòng 3 phút qua sẽ được coi là Online)
 const isUserOnline = (lastActive: any) => {
 if (!lastActive) return false;
 try {
 const activeTime = lastActive.toDate ? lastActive.toDate().getTime() : new Date(lastActive).getTime();
 const now = Date.now();
 return (now - activeTime) < 180000; // 3 phút = 180 giây
 } catch (e) {
 return false;
 }
 };

 const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
 const val = e.target.value;
 setInputText(val);

 // Không kích hoạt nhắc tên @ khi đang chat riêng tư
 if (chatType === 'private') return;

 const cursorPosition = e.target.selectionStart;
 const textBeforeCursor = val.substring(0, cursorPosition);
 const lastAtIdx = textBeforeCursor.lastIndexOf('@');

 if (lastAtIdx !== -1 && (lastAtIdx === 0 || textBeforeCursor[lastAtIdx - 1] === ' ' || textBeforeCursor[lastAtIdx - 1] === '\n')) {
 const queryText = textBeforeCursor.substring(lastAtIdx + 1);
 if (!queryText.includes(' ')) {
 setShowMentionSuggestions(true);
 setMentionQuery(queryText);
 setMentionStartIndex(lastAtIdx);
 return;
 }
 }
 
 setShowMentionSuggestions(false);
 };

 const selectMention = (selectedUser: UserProfile) => {
 if (mentionStartIndex === -1) return;

 const baseName = selectedUser.ten_that || selectedUser.displayName || selectedUser.email;
 const beforeMention = inputText.substring(0, mentionStartIndex);
 const afterMention = inputText.substring(textareaRef.current?.selectionStart || mentionStartIndex);
 
 const newText = `${beforeMention}@${baseName} ${afterMention}`;
 setInputText(newText);
 
 if (!selectedMentionUids.includes(selectedUser.uid)) {
 setSelectedMentionUids(prev => [...prev, selectedUser.uid]);
 }

 setShowMentionSuggestions(false);
 setMentionStartIndex(-1);
 
 setTimeout(() => {
 if (textareaRef.current) {
 textareaRef.current.focus();
 const cursorIdx = beforeMention.length + baseName.length + 2;
 textareaRef.current.setSelectionRange(cursorIdx, cursorIdx);
 }
 }, 50);
 };

 const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
 if (e.key === 'Enter' && !e.shiftKey) {
 e.preventDefault();
 handleSendMessage();
 }
 };

 // 5. Gửi tin nhắn (Nhóm hoặc Cá nhân)
 const handleSendMessage = async () => {
 if (!user || !inputText.trim()) return;

 const content = inputText.trim();
 setInputText('');
 setSelectedMentionUids([]);

 if (chatType === 'group') {
 // --- LUỒNG CHAT NHÓM ---
 const mentions: string[] = [];
 allUsers.forEach((u) => {
 const name = u.ten_that || u.displayName || u.email;
 if (content.includes(`@${name}`) && !mentions.includes(u.uid)) {
 mentions.push(u.uid);
 }
 });

 try {
 const msgData = cleanUndefinedFields({
 content,
 senderId: user.uid,
 senderName: userProfile?.ten_that || userProfile?.displayName || user.displayName || 'Nhân viên',
 senderTitle: userProfile?.chuc_danh || 'Nhân viên',
 senderPhoto: userProfile?.photoURL || user.photoURL || null,
 createdAt: serverTimestamp(),
 taggedUsers: mentions.length > 0 ? mentions : null
 });

 const docRef = await addDoc(collection(db, 'messages'), msgData);

 // Tạo thông báo nghiệp vụ nhúng tag thành viên
 const notifyPromises = mentions
 .filter(uid => uid !== user.uid)
 .map(async (uid) => {
 const notifyData = cleanUndefinedFields({
 title: 'Bạn được nhắc đến',
 content: `${userProfile?.ten_that || userProfile?.displayName || user.displayName || 'Thành viên'} đã nhắc đến bạn trong cuộc trao đổi nhóm.`,
 type: 'mention',
 createdAt: serverTimestamp(),
 targetUsers: [uid],
 readBy: [],
 linkTo: `exchange?msgId=${docRef.id}`
 });
 await addDoc(collection(db, 'notifications'), notifyData);
 });

 await Promise.all(notifyPromises);
 scrollToBottom();
 } catch (error) {
 console.error("Error creating chat message:", error);
 handleFirestoreError(error, OperationType.WRITE, 'messages');
 }
 } else {
 // --- LUỒNG CHAT RIÊNG TƯ (PRIVATE DM) ---
 if (!selectedPrivateUser) return;
 try {
 const privateMsgData = cleanUndefinedFields({
 content,
 senderId: user.uid,
 senderName: userProfile?.ten_that || userProfile?.displayName || user.displayName || 'Nhân viên',
 senderTitle: userProfile?.chuc_danh || 'Nhân viên',
 senderPhoto: userProfile?.photoURL || user.photoURL || null,
 receiverId: selectedPrivateUser.uid,
 createdAt: serverTimestamp()
 });

 await addDoc(collection(db, 'private_messages'), privateMsgData);

 // Đồng thời gửi một thông báo nổi (Business Notification) để người nhận nhìn thấy khi ở phần hành khác
 const notifyData = cleanUndefinedFields({
 title: 'Tin nhắn cá nhân mới',
 content: `${userProfile?.ten_that || userProfile?.displayName || user.displayName || 'Nhân viên'} đã gửi cho bạn một tin nhắn riêng.`,
 type: 'private_chat',
 createdAt: serverTimestamp(),
 targetUsers: [selectedPrivateUser.uid],
 readBy: [],
 linkTo: `exchange?msgId=private`
 });
 await addDoc(collection(db, 'notifications'), notifyData);

 scrollToBottom();
 } catch (error) {
 console.error("Error creating private message:", error);
 handleFirestoreError(error, OperationType.WRITE, 'private_messages');
 }
 }
 };

 // 6. Hàm biến đổi thời gian có Fallback An toàn triệt tiêu lỗi "Invalid Date"
 const formatChatTime = (timestamp: any) => {
 if (!timestamp) return 'Hôm nay';
 try {
 let date: Date;
 if (timestamp.toDate && typeof timestamp.toDate === 'function') {
 date = timestamp.toDate();
 } else if (timestamp.seconds) {
 date = new Date(timestamp.seconds * 1000);
 } else {
 date = new Date(timestamp);
 }
 if (isNaN(date.getTime())) {
 return 'Vừa xong';
 }
 return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
 } catch (e) {
 return 'Vừa xong';
 }
 };

 const formatChatDate = (timestamp: any) => {
 if (!timestamp) return 'Hôm nay';
 try {
 let date: Date;
 if (timestamp.toDate && typeof timestamp.toDate === 'function') {
 date = timestamp.toDate();
 } else if (timestamp.seconds) {
 date = new Date(timestamp.seconds * 1000);
 } else {
 date = new Date(timestamp);
 }
 if (isNaN(date.getTime())) {
 return 'Hôm nay';
 }
 return date.toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'numeric' });
 } catch (e) {
 return 'Hôm nay';
 }
 };

 const renderMessageContent = (content: string) => {
 if (!content) return '';
 const words = content.split(/(\s+|\n)/);
 return words.map((word, idx) => {
 if (word.startsWith('@')) {
 const potentialName = word.substring(1);
 const userExists = allUsers.some(u => {
 const name = u.ten_that || u.displayName || u.email;
 return potentialName.startsWith(name) || name.startsWith(potentialName);
 });
 
 if (userExists) {
 return (
 <span key={idx} className="font-bold bg-indigo-100 border border-indigo-100 text-indigo-600 px-1 py-0.5 rounded-sm inline-block mx-0.5 text-[13px]">
 {word}
 </span>
 );
 }
 }
 return word;
 });
 };

 const getFilteredMentions = () => {
 const term = mentionQuery.toLowerCase();
 return allUsers.filter(u => {
 const name = (u.ten_that || u.displayName || u.email).toLowerCase();
 const code = (u.chuc_danh || '').toLowerCase();
 return name.includes(term) || code.includes(term);
 });
 };

 // Lọc tin nhắn nhóm
 const filteredMessages = messages.filter((msg) => {
 if (!searchText.trim()) return true;
 const term = searchText.toLowerCase();
 const matchesContent = msg.content?.toLowerCase().includes(term);
 const matchesSender = msg.senderName?.toLowerCase().includes(term) || msg.senderTitle?.toLowerCase().includes(term);
 
 const matchesTag = allUsers.some(u => {
 const name = u.ten_that || u.displayName || u.email;
 return name.toLowerCase().includes(term) && msg.content?.toLowerCase().includes(`@${name.toLowerCase()}`);
 });

 return matchesContent || matchesSender || matchesTag;
 });

 // Nhóm tin nhắn theo ngày
 const groupedMessages: { [dateStr: string]: ChatMessage[] } = {};
 filteredMessages.forEach(msg => {
 const dateStr = formatChatDate(msg.createdAt) || 'Hôm nay';
 if (!groupedMessages[dateStr]) {
 groupedMessages[dateStr] = [];
 }
 groupedMessages[dateStr].push(msg);
 });

 // Nhóm tin nhắn riêng theo ngày
 const groupedPrivateMessages: { [dateStr: string]: PrivateMessage[] } = {};
 privateMessages.forEach(msg => {
 const dateStr = formatChatDate(msg.createdAt) || 'Hôm nay';
 if (!groupedPrivateMessages[dateStr]) {
 groupedPrivateMessages[dateStr] = [];
 }
 groupedPrivateMessages[dateStr].push(msg);
 });

 // Chuyển sang chat riêng tư với một người dùng cụ thể
 const startPrivateChat = (targetUser: UserProfile) => {
 setSelectedPrivateUser(targetUser);
 setChatType('private');
 setInputText('');
 
 // Lưu lại mốc thời gian vừa đọc tin nhắn người này
 if (user) {
 localStorage.setItem(`draco_pm_last_read_${user.uid}`, Date.now().toString());
 }
 
 setUnreadPrivateCounts(prev => {
 const clone = { ...prev };
 delete clone[targetUser.uid];
 return clone;
 });
 };

 return (
 <div className="flex flex-col lg:flex-row h-[calc(100vh-140px)] bg-white rounded-lg border border-slate-100 overflow-hidden shadow-sm" id="exchange-dashboard">
 
 {/* 1. Panel thành viên bên trái */}
 <aside className="w-full lg:w-76 bg-slate-100 border-r border-slate-100 flex flex-col shrink-0" id="members-list-panel">
 <div className="p-4 border-b border-rose-100/10 bg-slate-900 text-white flex flex-col gap-2">
 <div className="flex items-center justify-between">
 <div className="flex items-center space-x-2">
 <Users size={16} className="text-indigo-400" />
 <h3 className="font-black text-xs uppercase tracking-widest">Danh mục thành viên ({allUsers.length})</h3>
 </div>
 </div>
 
 {/* Nút chuyển đổi nhanh chế độ Chat Nhóm hoặc Chat Riêng tư */}
 <div className="grid grid-cols-2 gap-1.5 mt-1 bg-slate-800 p-1 rounded-sm">
 <button
 onClick={() => {
 setChatType('group');
 setSelectedPrivateUser(null);
 setInputText('');
 }}
 className={`py-1.5 px-2 text-[10px] font-black uppercase tracking-wider rounded-sm transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
 chatType === 'group' 
 ? 'bg-indigo-700 text-white shadow-sm' 
 : 'text-slate-400 hover:text-white'
 }`}
 >
 <MessageCircle size={12} />
 Kênh chung
 </button>
 <button
 onClick={() => {
 // Chọn người đầu tiên trong list làm mặc định nếu chưa chọn ai
 const otherUsers = allUsers.filter(u => u.uid !== user?.uid);
 if (otherUsers.length > 0) {
 startPrivateChat(otherUsers[0]);
 } else {
 setChatType('private');
 }
 }}
 className={`py-1.5 px-2 text-[10px] font-black uppercase tracking-wider rounded-sm transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
 chatType === 'private' 
 ? 'bg-indigo-700 text-white shadow-sm' 
 : 'text-slate-400 hover:text-white'
 }`}
 >
 <Lock size={12} />
 Nhắn riêng
 </button>
 </div>
 </div>

 {/* Danh sách thành viên bên dưới */}
 <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
 {allUsers.map((u) => {
 const isMe = u.uid === user?.uid;
 const online = isUserOnline(u.lastActive);
 const unreadCount = unreadPrivateCounts[u.uid] || 0;
 const isSelected = selectedPrivateUser?.uid === u.uid && chatType === 'private';
 
 return (
 <div
 key={u.uid}
 onClick={() => {
 if (isMe) {
 setChatType('group');
 setSelectedPrivateUser(null);
 } else {
 startPrivateChat(u);
 }
 }}
 className={`flex items-center justify-between p-2.5 rounded-sm border transition-all cursor-pointer ${
 isSelected 
 ? 'bg-indigo-100/70 border-indigo-200' 
 : 'bg-white border-slate-100 hover:border-slate-400 hover:bg-slate-100'
 }`}
 >
 <div className="flex items-center space-x-3 min-w-0">
 <div className="relative shrink-0">
 {u.photoURL ? (
 <img src={u.photoURL} alt="User" className="w-8.5 h-8.5 rounded-full border border-slate-200 object-cover" referrerPolicy="no-referrer" />
 ) : (
 <div className="w-8.5 h-8.5 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center font-black text-xs uppercase border border-slate-300">
 {(u.ten_that || u.displayName || u.email)[0]}
 </div>
 )}
 {/* Biểu tượng online (xanh) / offline (xám) cực kì sinh động */}
 <span 
 className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white ${
 online ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
 }`} 
 title={online ? 'Nhân viên đang trực tuyến' : 'Ngoại tuyến'}
 />
 </div>
 <div className="flex flex-col min-w-0">
 <span className="text-[11.5px] font-bold text-slate-900 truncate flex items-center gap-1">
 {u.ten_that || u.displayName} 
 {isMe && <span className="text-[9px] text-slate-400 font-normal scale-90 translate-y-px shrink-0">(Tôi)</span>}
 </span>
 <span className="text-[8.5px] font-black uppercase text-slate-500 tracking-wider">
 {u.chuc_danh || 'Nhân viên'}
 </span>
 </div>
 </div>

 {/* Badge số lượng tin nhắn riêng chưa đọc */}
 {unreadCount > 0 && (
 <span className="bg-rose-500 text-white text-[9px] font-black w-4.5 h-4.5 rounded-full flex items-center justify-center shrink-0 border border-white">
 {unreadCount}
 </span>
 )}
 </div>
 );
 })}
 </div>
 </aside>

 {/* 2. Workspace chính kết hợp Chat Nhóm & Chat Riêng tư */}
 <section className="flex-1 flex flex-col h-full bg-slate-100 relative" id="chat-workspace">
 
 {/* --- DÒNG TIÊU ĐỀ (HEADER) --- */}
 {chatType === 'group' ? (
 // Header cho Chat Nhóm
 <div className="h-14 bg-white border-b border-slate-200 px-4 flex items-center gap-3 shrink-0 shadow-sm">
 <div className="relative flex-1 max-w-sm">
 <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 pointer-events-none">
 <Search size={14} />
 </span>
 <input
 type="text"
 placeholder="Tìm tin nhắn, người gửi..."
 value={searchText}
 onChange={(e) => setSearchText(e.target.value)}
 className="w-full bg-slate-100 border border-slate-200 pl-8 pr-8 py-1.5 rounded-sm text-xs focus:outline-none focus:border-indigo-500 font-sans tracking-wide"
 />
 {searchText && (
 <button
 onClick={() => setSearchText('')}
 className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-600"
 >
 <X size={14} />
 </button>
 )}
 </div>
 <div className="ml-auto hidden sm:flex items-center text-[10px] font-black text-indigo-700 bg-indigo-100/50 uppercase tracking-widest px-3 py-1 rounded-sm border border-indigo-100/50">
 Kênh hội thoại chung
 </div>
 </div>
 ) : (
 // Header cho Chat Riêng tư
 <div className="h-14 bg-white border-b border-slate-200 px-4 flex items-center justify-between shrink-0 shadow-sm">
 {selectedPrivateUser ? (
 <div className="flex items-center space-x-3">
 <button 
 onClick={() => setChatType('group')}
 className="p-1.5 hover:bg-slate-100 rounded-sm text-slate-600 lg:hidden cursor-pointer shrink-0"
 >
 <ArrowLeft size={16} />
 </button>
 <div className="relative">
 {selectedPrivateUser.photoURL ? (
 <img src={selectedPrivateUser.photoURL} alt="" className="w-9 h-9 rounded-full border border-slate-200 object-cover shrink-0" referrerPolicy="no-referrer" />
 ) : (
 <div className="w-9 h-9 rounded-full bg-slate-100 text-slate-700 flex items-center justify-center font-bold text-xs uppercase shrink-0 border border-slate-200">
 {(selectedPrivateUser.ten_that || selectedPrivateUser.displayName || selectedPrivateUser.email)[0]}
 </div>
 )}
 <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white ${
 isUserOnline(selectedPrivateUser.lastActive) ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
 }`} />
 </div>
 <div className="flex flex-col min-w-0">
 <h4 className="text-xs font-bold text-slate-800 leading-tight">
 Hội thoại với {selectedPrivateUser.ten_that || selectedPrivateUser.displayName}
 </h4>
 <p className="text-[10px] text-slate-500 tracking-wide">
 {selectedPrivateUser.chuc_danh || 'Mỹ Nghệ Draco'} • {isUserOnline(selectedPrivateUser.lastActive) ? 'Đang hoạt động' : 'Tạm thời ngoại tuyến'}
 </p>
 </div>
 </div>
 ) : (
 <p className="text-xs font-bold text-slate-500 uppercase">Chọn một người hoạt động để nhắn riêng</p>
 )}
 
 <div className="flex items-center text-[9px] font-black uppercase text-indigo-700 bg-indigo-100 border border-indigo-100 px-3 py-1 rounded-sm leading-none">
 <Lock size={10} className="mr-1 inline" /> Bảo mật 1-1
 </div>
 </div>
 )}

 {/* --- KHU VỰC HIỂN THỊ TIN NHẮN (VIEWPORT) --- */}
 {chatType === 'group' ? (
 // Viewport Chat Nhóm
 <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4">
 {loading ? (
 <div className="flex flex-col items-center justify-center h-full space-y-3">
 <div className="w-7 h-7 border-3 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
 <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Đang liên kết dữ liệu...</p>
 </div>
 ) : filteredMessages.length === 0 ? (
 <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-3">
 <div className="p-4 bg-white rounded-full text-slate-500 border border-slate-200">
 <MessageSquare size={32} />
 </div>
 <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Chưa có tin nhắn nào</p>
 </div>
 ) : (
 Object.keys(groupedMessages).map((date) => (
 <div key={date} className="space-y-4">
 <div className="flex items-center justify-center my-4">
 <div className="h-px bg-slate-200 flex-1"></div>
 <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 px-3 z-10 rounded-sm">
 {date}
 </span>
 <div className="h-px bg-slate-200 flex-1"></div>
 </div>

 {groupedMessages[date].map((msg) => {
 const isMe = msg.senderId === user?.uid;
 return (
 <motion.div
 key={msg.id}
 initial={{ opacity: 0, y: 10 }}
 animate={{ opacity: 1, y: 0 }}
 className={`flex items-start gap-3 ${isMe ? 'flex-row-reverse' : ''}`}
 >
 <div className="shrink-0" onClick={() => !isMe && selectUserForPrivateMsg(msg.senderId)}>
 {msg.senderPhoto ? (
 <img src={msg.senderPhoto} alt="" className="w-8.5 h-8.5 rounded-full border border-slate-200 object-cover cursor-pointer hover:scale-105 transition-transform" referrerPolicy="no-referrer" />
 ) : (
 <div className="w-8.5 h-8.5 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center font-bold text-sm uppercase cursor-pointer border border-slate-400">
 {msg.senderName[0]}
 </div>
 )}
 </div>

 <div className={`flex flex-col max-w-[75%] ${isMe ? 'items-end' : 'items-start'}`}>
 <div className="flex items-center space-x-2 mb-1">
 <span className="text-[11.5px] font-bold text-slate-800">{msg.senderName}</span>
 {msg.senderTitle && (
 <span className="bg-white text-slate-500 border border-slate-200 text-[8.5px] px-1.5 py-0.5 rounded-sm font-black uppercase tracking-wider">
 {msg.senderTitle}
 </span>
 )}
 </div>

 <div className={`p-3.5 rounded-lg border text-xs leading-relaxed break-words w-full ${
 isMe 
 ? 'bg-slate-900 text-white border-slate-800 rounded-tr-none' 
 : 'bg-white text-slate-800 border-slate-200 rounded-tl-none'
 }`}>
 <p className="whitespace-pre-wrap select-text">
 {renderMessageContent(msg.content)}
 </p>
 </div>

 <span className="text-[9px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
 <Clock size={9} />
 {formatChatTime(msg.createdAt)}
 </span>
 </div>
 </motion.div>
 );
 })}
 </div>
 ))
 )}
 <div ref={messagesEndRef} />
 </div>
 ) : (
 // Viewport Chat Riêng tư
 <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4">
 {!selectedPrivateUser ? (
 <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-3">
 <div className="p-4 bg-white rounded-full border border-slate-200">
 <User size={32} />
 </div>
 <p className="text-[11px] font-black uppercase tracking-widest text-slate-500">Vui lòng chọn một thành viên bên trái</p>
 <p className="text-[9px] text-slate-400 uppercase">Để bắt đầu cuộc trò chuyện riêng tư được mã hoá an toàn.</p>
 </div>
 ) : loadingPrivate ? (
 <div className="flex flex-col items-center justify-center h-full space-y-3">
 <div className="w-7 h-7 border-3 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
 <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Đang mã hóa đường truyền bảo mật...</p>
 </div>
 ) : privateMessages.length === 0 ? (
 <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-3">
 <div className="p-4 bg-white rounded-full border border-slate-200 text-indigo-500">
 <Lock size={28} />
 </div>
 <p className="text-[10px] font-black uppercase tracking-widest text-indigo-700">Bắt đầu trò chuyện bí mật</p>
 <p className="text-[9px] text-slate-405 uppercase tracking-wide text-center max-w-[280px]">Nội dung trò chuyện chỉ hiển thị riêng cho hai bạn và hoàn toàn riêng tư.</p>
 </div>
 ) : (
 Object.keys(groupedPrivateMessages).map((date) => (
 <div key={date} className="space-y-4">
 <div className="flex items-center justify-center my-4">
 <div className="h-px bg-slate-200 flex-1"></div>
 <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 px-3 z-10 rounded-sm">
 {date}
 </span>
 <div className="h-px bg-slate-200 flex-1"></div>
 </div>

 {groupedPrivateMessages[date].map((msg) => {
 const isMe = msg.senderId === user?.uid;
 return (
 <motion.div
 key={msg.id}
 initial={{ opacity: 0, y: 10 }}
 animate={{ opacity: 1, y: 0 }}
 className={`flex items-start gap-3 ${isMe ? 'flex-row-reverse' : ''}`}
 >
 <div className="shrink-0">
 {msg.senderPhoto ? (
 <img src={msg.senderPhoto} alt="" className="w-8.5 h-8.5 rounded-full border border-slate-200 object-cover" />
 ) : (
 <div className="w-8.5 h-8.5 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center font-bold text-sm uppercase border border-slate-400">
 {msg.senderName[0]}
 </div>
 )}
 </div>

 <div className={`flex flex-col max-w-[75%] ${isMe ? 'items-end' : 'items-start'}`}>
 <div className="flex items-center space-x-2 mb-1">
 <span className="text-[11.5px] font-bold text-slate-800">{msg.senderName}</span>
 {msg.senderTitle && (
 <span className="bg-white text-slate-500 border border-slate-200 text-[8.5px] px-1.5 py-0.5 rounded-sm font-black uppercase tracking-wider">
 {msg.senderTitle}
 </span>
 )}
 </div>

 <div className={`p-3.5 rounded-lg border text-xs leading-relaxed break-words w-full ${
 isMe 
 ? 'bg-indigo-700 text-white border-indigo-600 rounded-tr-none' 
 : 'bg-white text-slate-800 border-slate-200 rounded-tl-none'
 }`}>
 <p className="whitespace-pre-wrap select-text">{msg.content}</p>
 </div>

 <span className="text-[9px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
 <Clock size={9} />
 {formatChatTime(msg.createdAt)}
 </span>
 </div>
 </motion.div>
 );
 })}
 </div>
 ))
 )}
 <div ref={privateMessagesEndRef} />
 </div>
 )}

 {/* --- Hộp gợi ý Tag thành viên --- */}
 <AnimatePresence>
 {showMentionSuggestions && getFilteredMentions().length > 0 && (
 <motion.div
 initial={{ opacity: 0, y: 15 }}
 animate={{ opacity: 1, y: 0 }}
 exit={{ opacity: 0, y: 15 }}
 className="absolute left-4 right-4 bottom-22 bg-white border border-slate-200 rounded-lg shadow-2xl z-100 overflow-hidden max-h-48"
 id="mention-portal"
 >
 <div className="p-2 border-b bg-slate-900 text-white flex justify-between items-center">
 <span className="text-[9px] tracking-widest font-black uppercase text-indigo-400">Nhắc đến thành viên</span>
 </div>
 <div className="overflow-y-auto max-h-36 p-1 space-y-1">
 {getFilteredMentions().map((u) => (
 <button
 key={u.uid}
 onClick={() => selectMention(u)}
 className="w-full flex items-center space-x-3 p-2 text-left rounded-sm hover:bg-slate-100 transition-colors cursor-pointer"
 >
 {u.photoURL ? (
 <img src={u.photoURL} alt="" className="w-6 h-6 rounded-full object-cover" />
 ) : (
 <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center font-bold text-xs">
 {(u.ten_that || u.displayName || u.email)[0]}
 </div>
 )}
 <div className="flex-1 min-w-0">
 <span className="text-xs font-bold text-slate-800 truncate block">{u.ten_that || u.displayName}</span>
 <span className="text-[8px] text-slate-500 uppercase tracking-widest block">{u.chuc_danh || 'Nhân viên'}</span>
 </div>
 </button>
 ))}
 </div>
 </motion.div>
 )}
 </AnimatePresence>

 {/* --- KHUNG PHÍA DƯỚI (INPUT) --- */}
 <div className="p-4 bg-white border-t border-slate-200 shrink-0">
 <div className="flex items-center gap-3">
 <textarea
 ref={textareaRef}
 rows={2}
 value={inputText}
 onChange={handleInputChange}
 onKeyDown={handleKeyPress}
 disabled={chatType === 'private' && !selectedPrivateUser}
 placeholder={
 chatType === 'group' 
 ? "Nhập dấu @ để tag nhanh thành viên..." 
 : selectedPrivateUser 
 ? `Nhập nội dung gửi riêng tới ${selectedPrivateUser.ten_that || selectedPrivateUser.displayName}...` 
 : "Chọn một nhân viên bên trái để gửi tin riêng..."
 }
 className="flex-1 bg-slate-100 border border-slate-200 rounded-sm p-3 text-xs placeholder-slate-400 focus:outline-none focus:border-indigo-500 resize-none min-h-[50px] max-h-[120px] leading-relaxed disabled:opacity-100"
 />
 <button
 onClick={handleSendMessage}
 disabled={!inputText.trim() || (chatType === 'private' && !selectedPrivateUser)}
 className="p-3 bg-indigo-700 hover:bg-slate-900 text-white rounded-sm transition-all active:scale-95 disabled:bg-slate-100 disabled:text-slate-400 shrink-0 cursor-pointer"
 title="Gửi tin nhắn"
 >
 <Send size={16} />
 </button>
 </div>
 <div className="mt-2 flex items-center justify-between text-[9px] text-slate-400 font-bold uppercase tracking-wider">
 <span>
 {chatType === 'group' ? (
 <>Ấn @ để tag thành viên • Nhấn Enter để gửi đi</>
 ) : (
 <>Hội thoại riêng bảo mật • Nhấn Enter để gửi</>
 )}
 </span>
 <span>Shift + Enter để xuống dòng</span>
 </div>
 </div>

 </section>

 </div>
 );

 // Helper chuyển nhanh người chat từ group avatar click
 function selectUserForPrivateMsg(senderId: string) {
 const target = allUsers.find(u => u.uid === senderId);
 if (target && target.uid !== user?.uid) {
 startPrivateChat(target);
 }
 }
}
