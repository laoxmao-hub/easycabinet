import React, { useState, useEffect } from 'react';
import { 
  Plus, Check, MessageSquare, Calendar, ChevronLeft, ChevronRight, 
  Trash2, CheckCircle, ListTodo
} from 'lucide-react';
import { 
  collection, query, orderBy, onSnapshot, doc, addDoc, 
  updateDoc, deleteDoc, serverTimestamp, arrayUnion 
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Task, CalendarNote } from '../types';
import { useAuth } from '../lib/AuthContext';
import { motion, AnimatePresence } from 'motion/react';

export function PlanningScreen() {
  const { user, userProfile } = useAuth();
  
  // Real-time states
  const [tasks, setTasks] = useState<Task[]>([]);
  const [calendarNotes, setCalendarNotes] = useState<CalendarNote[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  
  // UI States
  const [activeDeptFilter, setActiveDeptFilter] = useState<'All' | 'Sơn' | 'Lắp Ráp' | 'Đóng Gói'>('All');
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);

  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  });
  
  // Month state for Calendar
  const [currentMonth, setCurrentMonth] = useState<Date>(new Date());
  
  // Modal / Form States
  const [showCreateTaskModal, setShowCreateTaskModal] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDept, setNewTaskDept] = useState<'Sơn' | 'Lắp Ráp' | 'Đóng Gói'>('Sơn');
  const [newTaskDueDate, setNewTaskDueDate] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [newTaskNote, setNewTaskNote] = useState('');
  
  // Add note to task state
  const [activeTaskForNote, setActiveTaskForNote] = useState<string | null>(null);
  const [quickNoteText, setQuickNoteText] = useState('');
  
  // Create quick calendar note state
  const [quickCalNoteText, setQuickCalNoteText] = useState('');

  // 1. Listen to real-time Tasks
  useEffect(() => {
    const qTasks = query(collection(db, 'tasks'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(qTasks, (snapshot) => {
      const list = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as Task));
      setTasks(list);
      setLoadingTasks(false);
    }, (error) => {
      console.error("Lỗi đồng bộ tasks:", error);
      setLoadingTasks(false);
    });
    return () => unsub();
  }, []);

  // 2. Listen to real-time Calendar Notes
  useEffect(() => {
    const qNotes = query(collection(db, 'calendar_notes'), orderBy('createdAt', 'asc'));
    const unsub = onSnapshot(qNotes, (snapshot) => {
      const list = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as CalendarNote));
      setCalendarNotes(list);
    }, (error) => {
      console.error("Lỗi đồng bộ calendar notes:", error);
    });
    return () => unsub();
  }, []);

  // Create Task
  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim() || !user) return;
    
    try {
      const taskData = {
        title: newTaskTitle.trim(),
        department: newTaskDept,
        notes: newTaskNote.trim() ? [newTaskNote.trim()] : [],
        isCompleted: false,
        dueDate: newTaskDueDate || null,
        priority: newTaskPriority,
        createdBy: userProfile?.ten_that || user.displayName || user.email || 'Ẩn danh',
        createdByEmail: user.email || '',
        createdAt: serverTimestamp()
      };
      
      await addDoc(collection(db, 'tasks'), taskData);
      
      // Reset form
      setNewTaskTitle('');
      setNewTaskDept('Sơn');
      setNewTaskDueDate('');
      setNewTaskPriority('medium');
      setNewTaskNote('');
      setShowCreateTaskModal(false);
    } catch (err) {
      console.error("Lỗi tạo công việc:", err);
      alert("Không thể tạo công việc. Vui lòng thử lại!");
    }
  };

  // Mark task as complete
  const handleToggleComplete = async (taskId: string, currentStatus: boolean) => {
    const action = currentStatus ? 'bỏ đánh dấu hoàn thành' : 'đánh dấu hoàn thành';
    if (!confirm(`Bạn có chắc muốn ${action} công việc này?`)) return;
    try {
      await updateDoc(doc(db, 'tasks', taskId), {
        isCompleted: !currentStatus,
        completedAt: !currentStatus ? serverTimestamp() : null
      });
    } catch (err) {
      console.error("Lỗi cập nhật trạng thái công việc:", err);
    }
  };

  // Add quick note to Task
  const handleAddTaskNote = async (taskId: string) => {
    if (!quickNoteText.trim() || !user) return;
    try {
      const noteWithUser = `${quickNoteText.trim()} (${user.displayName || user.email} - ${new Date().toLocaleDateString('vi-VN')})`;
      await updateDoc(doc(db, 'tasks', taskId), {
        notes: arrayUnion(noteWithUser)
      });
      setQuickNoteText('');
      setActiveTaskForNote(null);
    } catch (err) {
      console.error("Lỗi thêm ghi chú:", err);
    }
  };

  // Delete Task
  const handleDeleteTask = async (taskId: string) => {
    if (!confirm("Bạn có chắc chắn muốn xóa công việc này? Hành động này không thể hoàn tác.")) return;
    try {
      await deleteDoc(doc(db, 'tasks', taskId));
    } catch (err) {
      console.error("Lỗi xóa công việc:", err);
    }
  };

  // Create Calendar Note
  const handleCreateCalNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickCalNoteText.trim() || !user) return;
    
    try {
      const noteData = {
        date: selectedDate,
        note: quickCalNoteText.trim(),
        createdBy: userProfile?.ten_that || user.displayName || user.email || 'Ẩn danh',
        createdByEmail: user.email || '',
        createdAt: serverTimestamp()
      };
      
      await addDoc(collection(db, 'calendar_notes'), noteData);
      setQuickCalNoteText('');
    } catch (err) {
      console.error("Lỗi tạo ghi chú lịch:", err);
    }
  };

  // Delete Calendar Note
  const handleDeleteCalNote = async (noteId: string) => {
    if (!confirm("Bạn có chắc chắn muốn xóa ghi chú này?")) return;
    try {
      await deleteDoc(doc(db, 'calendar_notes', noteId));
    } catch (err) {
      console.error("Lỗi xóa ghi chú lịch:", err);
    }
  };

  // Helper: Month navigation
  const prevMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  };
  const nextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  };

  // Generate Calendar Days
  const getDaysInMonth = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    
    const firstDayIndex = new Date(year, month, 1).getDay(); // Sunday is 0, Monday is 1...
    // Adjust Sunday to be 7th index or start week from Monday
    const startOffset = firstDayIndex === 0 ? 6 : firstDayIndex - 1;
    
    const numDays = new Date(year, month + 1, 0).getDate();
    const days = [];
    
    // Previous month empty slots
    for (let i = 0; i < startOffset; i++) {
      days.push(null);
    }
    
    // Current month days
    for (let d = 1; d <= numDays; d++) {
      const dayStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push({
        day: d,
        dateString: dayStr
      });
    }
    
    return days;
  };

  const days = getDaysInMonth();
  const weekDays = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

  // Filtered Tasks for Cột Trái (3/4)
  const filteredTasks = tasks.filter(task => {
    const matchDept = activeDeptFilter === 'All' || task.department === activeDeptFilter;
    const matchCompleted = task.isCompleted === showCompletedTasks;
    return matchDept && matchCompleted;
  });

  // Get items for selected date on Calendar Panel (Cột Phải)
  const tasksDueOnSelectedDate = tasks.filter(t => t.dueDate === selectedDate);
  const notesOnSelectedDate = calendarNotes.filter(n => n.date === selectedDate);

  // Format date helper
  const formatDateVi = (dateStr: string) => {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6 min-h-full pb-10" id="planning-screen-container">
      {/* CỘT TRÁI - KẾ HOẠCH & TIẾN ĐỘ */}
      <div className="w-full lg:w-[55%] flex flex-col space-y-6" id="left-planning-column">

        {/* Header bento panel */}
        <div className="bg-white p-6 rounded-lg border border-slate-100 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
              <ListTodo size={22} className="text-indigo-600" />
              Kế Hoạch & Tiến Độ Tổ Sản Xuất
            </h2>
            <p className="text-xs text-slate-400 font-bold uppercase tracking-wider">
              Quản lý công việc tồn đọng của từng tổ: Sơn, Lắp Ráp, Đóng Gói
            </p>
          </div>

          <button
            onClick={() => setShowCreateTaskModal(true)}
            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-black uppercase tracking-wider flex items-center gap-1.5 transition-colors cursor-pointer justify-center"
          >
            <Plus size={16} />
            <span>Tạo Công Việc</span>
          </button>
        </div>

        {/* Task List - Filter Bar & List Container */}
        <div className="bg-white rounded-lg border border-slate-100 overflow-hidden flex flex-col">
          {/* Tabs Filter */}
          <div className="px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-slate-100/30">
            <div className="flex gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-hide">
              {(['All', 'Sơn', 'Lắp Ráp', 'Đóng Gói'] as const).map((dept) => (
                <button
                  key={dept}
                  onClick={() => setActiveDeptFilter(dept)}
                  className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-tight transition-all cursor-pointer whitespace-nowrap border ${
                    activeDeptFilter === dept
                      ? 'bg-indigo-600 text-white border-transparent'
                      : 'bg-white text-slate-500 hover:text-slate-800 border-slate-200'
                  }`}
                >
                  {dept === 'All' ? 'TẤT CẢ TỔ' : dept}
                </button>
              ))}
            </div>

            {/* Toggle Show Completed */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-tight">Trạng thái:</span>
              <button
                onClick={() => setShowCompletedTasks(!showCompletedTasks)}
                className={`px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-tight transition-all border ${
                  showCompletedTasks
                    ? 'bg-emerald-600 text-white border-transparent'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {showCompletedTasks ? 'ĐÃ HOÀN THÀNH' : 'CÒN TỒN ĐỌNG'}
              </button>
            </div>
          </div>

          {/* List content */}
          <div className="p-6">
            {loadingTasks ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-400 space-y-3">
                <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-xs font-black uppercase tracking-widest text-indigo-600">Đang tải công việc...</p>
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="text-center py-24 text-slate-400 flex flex-col items-center justify-center space-y-4">
                <div className="p-4 bg-slate-100 rounded-full text-slate-300">
                  <ListTodo size={40} />
                </div>
                <div className="space-y-1">
                  <h4 className="text-sm font-black uppercase tracking-wide text-slate-700">Không có công việc nào</h4>
                  <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
                    {showCompletedTasks
                      ? "Không tìm thấy công việc đã hoàn thành nào cho lựa chọn bộ lọc này."
                      : "Tuyệt vời! Hiện tại không có công việc nào còn tồn đọng cho tổ này."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {(['Sơn', 'Lắp Ráp', 'Đóng Gói'] as const).map(dept => {
                  const deptTasks = filteredTasks.filter(t => t.department === dept);
                  if (deptTasks.length === 0) return null;
                  const styles = dept === 'Sơn'
                    ? { badge: 'bg-indigo-100 text-indigo-600', headerBg: 'bg-indigo-100/60 border-indigo-200/50', label: 'text-indigo-700', count: 'text-indigo-500 bg-indigo-200/50', icon: 'bg-indigo-500' }
                    : dept === 'Lắp Ráp'
                    ? { badge: 'bg-emerald-100 text-emerald-600', headerBg: 'bg-emerald-100/60 border-emerald-200/50', label: 'text-emerald-700', count: 'text-emerald-500 bg-emerald-200/50', icon: 'bg-emerald-500' }
                    : { badge: 'bg-amber-100 text-amber-600', headerBg: 'bg-amber-100/60 border-amber-200/50', label: 'text-amber-700', count: 'text-amber-500 bg-amber-200/50', icon: 'bg-amber-500' };
                  return (
                    <div key={dept} className="space-y-3">
                      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${styles.headerBg} border`}>
                        <div className={`w-6 h-6 rounded-lg ${styles.icon} text-white flex items-center justify-center text-[10px] font-black`}>
                          {dept === 'Sơn' ? 'S' : dept === 'Lắp Ráp' ? 'LR' : 'ĐG'}
                        </div>
                        <h3 className={`text-xs font-black uppercase tracking-wider ${styles.label}`}>
                          Tổ {dept}
                        </h3>
                        <span className={`text-[10px] font-black ${styles.count} px-2 py-0.5 rounded-lg`}>
                          {deptTasks.length} việc
                        </span>
                      </div>
                      <div className="space-y-1 pl-2 border-l-2 border-slate-100">
                        {deptTasks.map((task) => (
                          <div key={task.id} className={`rounded-lg transition-all bg-white ${task.isCompleted ? 'opacity-60' : ''}`}>
                            {/* Dòng công việc chính - double click để thêm ghi chú */}
                            <div
                              onDoubleClick={() => setActiveTaskForNote(task.id || null)}
                              className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer select-none ${
                                task.isCompleted ? 'border-slate-200 bg-slate-50' : 'border-slate-100 hover:border-indigo-200'
                              }`}
                            >
                              <button
                                onClick={() => task.id && handleToggleComplete(task.id, task.isCompleted)}
                                className={`w-4 h-4 rounded flex items-center justify-center border transition-all shrink-0 cursor-pointer ${
                                  task.isCompleted
                                    ? 'bg-emerald-600 border-transparent text-white'
                                    : 'border-slate-300 hover:border-indigo-500'
                                }`}
                              >
                                {task.isCompleted && <Check size={10} strokeWidth={3} />}
                              </button>

                              <span className={`px-1.5 py-0.5 rounded text-[8px] font-black shrink-0 ${
                                task.priority === 'high' ? 'bg-red-100 text-red-700' :
                                task.priority === 'medium' ? 'bg-orange-100 text-orange-700' :
                                'bg-slate-100 text-slate-500'
                              }`}>
                                {task.priority === 'high' ? 'Cao' : task.priority === 'medium' ? 'TB' : 'Thấp'}
                              </span>

                              <span className={`text-sm font-bold flex-1 truncate ${task.isCompleted ? 'line-through text-slate-400' : 'text-slate-700'}`}>
                                {task.title}
                              </span>

                              {task.dueDate && (
                                <span className="flex items-center gap-0.5 text-[9px] text-slate-400 shrink-0">
                                  <Calendar size={9} />
                                  {formatDateVi(task.dueDate)}
                                </span>
                              )}

                              {task.notes && task.notes.length > 0 && (
                                <MessageSquare size={10} className="text-slate-300 shrink-0" />
                              )}

                              <button
                                onClick={() => task.id && handleDeleteTask(task.id)}
                                className="p-1 text-slate-300 hover:text-rose-500 rounded transition-colors cursor-pointer shrink-0"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>

                            {/* Ghi chú bên dưới */}
                            {task.notes && task.notes.length > 0 && (
                              <div className="pl-7 pr-3 pb-1">
                                {task.notes.map((note, index) => (
                                  <p key={index} className="text-sm text-slate-500 leading-relaxed truncate">
                                    {note.split(' (')[0]}
                                  </p>
                                ))}
                              </div>
                            )}

                            {/* Thêm ghi chú nhanh */}
                            {activeTaskForNote === task.id && (
                              <div className="pl-7 pr-3 pb-1 flex gap-1.5 items-center">
                                <input
                                  type="text"
                                  value={quickNoteText}
                                  onChange={(e) => setQuickNoteText(e.target.value)}
                                  placeholder="Nhập ghi chú..."
                                  className="flex-1 px-2 py-1 bg-slate-100 border border-slate-200 rounded text-[10px] font-bold text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') task.id && handleAddTaskNote(task.id);
                                  }}
                                  autoFocus
                                />
                                <button
                                  onClick={() => task.id && handleAddTaskNote(task.id)}
                                  disabled={!quickNoteText.trim()}
                                  className="px-2 py-1 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 rounded text-[9px] font-bold cursor-pointer"
                                >Lưu</button>
                                <button
                                  onClick={() => { setActiveTaskForNote(null); setQuickNoteText(''); }}
                                  className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-600 rounded text-[9px] font-bold cursor-pointer"
                                >Hủy</button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* CỘT PHẢI - LỊCH TRÌNH & DEADLINE */}
      <div className="w-full lg:w-[45%] flex flex-col space-y-6" id="right-planning-column">

        {/* Calendar Card */}
        <div className="bg-white rounded-lg border border-slate-100 p-5 flex flex-col space-y-4" id="calendar-card">
          {/* Header Month Navigate */}
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
              <Calendar size={14} className="text-indigo-600" />
              Lịch Biểu & Hạn Chót
            </h3>
            <div className="flex items-center gap-1">
              <button
                onClick={prevMonth}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-600 cursor-pointer"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-xs font-black text-slate-800 uppercase tracking-tight whitespace-nowrap min-w-[80px] text-center">
                T{currentMonth.getMonth() + 1} / {currentMonth.getFullYear()}
              </span>
              <button
                onClick={nextMonth}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-600 cursor-pointer"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* Grid of days */}
          <div className="grid grid-cols-7 gap-1 text-center">
            {weekDays.map(wd => (
              <span key={wd} className="text-[10px] font-black uppercase text-slate-400 py-1">{wd}</span>
            ))}

            {days.map((d, index) => {
              if (d === null) {
                return <div key={`empty-${index}`} className="min-h-[80px]" />;
              }

              const isSelected = d.dateString === selectedDate;

              const todayObj = new Date();
              const todayStr = `${todayObj.getFullYear()}-${String(todayObj.getMonth() + 1).padStart(2, '0')}-${String(todayObj.getDate()).padStart(2, '0')}`;
              const isToday = d.dateString === todayStr;

              const dayTasks = tasks.filter(t => t.dueDate === d.dateString && !t.isCompleted);
              const dayNotes = calendarNotes.filter(n => n.date === d.dateString);

              return (
                <button
                  key={`day-${d.day}`}
                  onClick={() => setSelectedDate(d.dateString)}
                  className={`min-h-[80px] p-1.5 relative rounded-lg flex flex-col items-center text-[10px] font-bold transition-all cursor-pointer text-left overflow-hidden ${
                    isSelected
                      ? 'bg-indigo-600 text-white ring-1 ring-indigo-400'
                      : isToday
                        ? 'bg-indigo-100 text-indigo-700 border border-indigo-200'
                        : 'hover:bg-slate-100 text-slate-700 border border-transparent'
                  }`}
                >
                  <span className={`text-xs font-black mb-0.5 ${isSelected ? '' : isToday ? 'text-indigo-600' : 'text-slate-700'}`}>
                    {d.day}
                  </span>

                  <div className="w-full flex flex-col gap-0.5 overflow-hidden">
                    {dayNotes.slice(0, 2).map(n => (
                      <span
                        key={n.id}
                        className={`block truncate rounded px-1 py-0.5 text-[9px] font-black leading-tight ${
                          isSelected
                            ? 'bg-white/20 text-white'
                            : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {n.note}
                      </span>
                    ))}
                    {dayNotes.length > 2 && (
                      <span className={`text-[9px] font-black text-center ${isSelected ? 'text-white/70' : 'text-slate-400'}`}>
                        +{dayNotes.length - 2}
                      </span>
                    )}
                    {dayTasks.length > 0 && dayNotes.length === 0 && (
                      <span className={`w-1.5 h-1.5 rounded-full mx-auto mt-0.5 ${isSelected ? 'bg-white/60' : 'bg-rose-400'}`} />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Date Detail Panel */}
        <div className="bg-white rounded-lg border border-slate-100 p-5 flex flex-col space-y-4" id="selected-date-detail-panel">
          <div className="border-b border-slate-100 pb-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Chi tiết ngày</span>
            <h4 className="text-xs font-black text-slate-800 uppercase mt-0.5">
              {formatDateVi(selectedDate)}
            </h4>
          </div>

          <div className="space-y-3">
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block">
              Công việc đến hạn ({tasksDueOnSelectedDate.length}):
            </span>
            {tasksDueOnSelectedDate.length === 0 ? (
              <p className="text-sm text-slate-400 uppercase font-black tracking-wide text-center py-2">Không có công việc nào</p>
            ) : (
              <div className="space-y-2">
                {tasksDueOnSelectedDate.map(t => (
                  <div key={t.id} className="p-2.5 bg-slate-100 rounded-lg border border-slate-200 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className={`text-xs font-bold text-slate-700 truncate ${t.isCompleted ? 'line-through text-slate-400 font-medium' : ''}`}>
                        {t.title}
                      </p>
                      <span className="text-[9px] font-black text-slate-400 uppercase mt-0.5 block">
                        Tổ: {t.department} • Priority: {t.priority === 'high' ? 'Cao' : t.priority === 'medium' ? 'Trung bình' : 'Thấp'}
                      </span>
                    </div>
                    {t.isCompleted && (
                      <CheckCircle size={14} className="text-emerald-600 shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 pt-2 border-t border-slate-100">
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block">
              Ghi chú deadline ({notesOnSelectedDate.length}):
            </span>
            {notesOnSelectedDate.length === 0 ? (
              <p className="text-[11px] text-slate-400 uppercase font-black tracking-wide text-center py-2">Không có ghi chú nào</p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {notesOnSelectedDate.map(n => (
                  <div key={n.id} className="p-2.5 bg-amber-100/50 rounded-lg border border-amber-200 flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <p className="text-xs font-bold text-slate-700 leading-normal break-words">
                        {n.note}
                      </p>
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider block">
                        Bởi: {n.createdBy}
                      </span>
                    </div>
                    {n.id && (
                      <button
                        onClick={() => handleDeleteCalNote(n.id!)}
                        className="p-1 text-slate-400 hover:text-rose-600 rounded cursor-pointer shrink-0"
                        title="Xóa ghi chú"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={handleCreateCalNote} className="pt-3 border-t border-slate-100 flex flex-col gap-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Ghi chú nhanh lên lịch:
            </span>
            <div className="flex gap-2">
              <input
                type="text"
                required
                value={quickCalNoteText}
                onChange={(e) => setQuickCalNoteText(e.target.value)}
                placeholder="Ví dụ: Giao hàng cho KH, Xong tổ Sơn..."
                className="flex-1 px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="submit"
                disabled={!quickCalNoteText.trim()}
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-black uppercase tracking-wide cursor-pointer shrink-0"
              >
                Ghi
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* CREATE TASK MODAL */}
      <AnimatePresence>
        {showCreateTaskModal && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-[150] overflow-y-auto">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-lg border border-slate-200 shadow-2xl overflow-hidden w-full max-w-lg"
            >
              {/* Modal header */}
              <div className="bg-slate-900 px-6 py-4 text-white flex items-center justify-between">
                <h3 className="text-sm font-black uppercase tracking-widest">Tạo Công Việc Tiến Độ Mới</h3>
                <button
                  type="button"
                  onClick={() => setShowCreateTaskModal(false)}
                  className="text-slate-400 hover:text-white transition-colors cursor-pointer text-xs font-bold"
                >
                  Đóng
                </button>
              </div>

              {/* Modal body */}
              <form onSubmit={handleCreateTask} className="p-6 space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Tên công việc / Nhiệm vụ *</label>
                  <input
                    type="text"
                    required
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    placeholder="Nhập tên việc cần làm..."
                    className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Tổ phụ trách / Thực hiện</label>
                    <select
                      value={newTaskDept}
                      onChange={(e) => setNewTaskDept(e.target.value as any)}
                      className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg text-xs font-black text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    >
                      <option value="Sơn">Sơn</option>
                      <option value="Lắp Ráp">Lắp Ráp</option>
                      <option value="Đóng Gói">Đóng Gói</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Mức độ ưu tiên</label>
                    <select
                      value={newTaskPriority}
                      onChange={(e) => setNewTaskPriority(e.target.value as any)}
                      className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg text-xs font-black text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    >
                      <option value="low">Thấp</option>
                      <option value="medium">Trung bình</option>
                      <option value="high">Cao (Gấp)</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Ngày hạn chót (Deadline)</label>
                  <input
                    type="date"
                    value={newTaskDueDate}
                    onChange={(e) => setNewTaskDueDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Ghi chú / Yêu cầu ban đầu</label>
                  <textarea
                    rows={3}
                    value={newTaskNote}
                    onChange={(e) => setNewTaskNote(e.target.value)}
                    placeholder="Mô tả cụ thể yêu cầu của công việc..."
                    className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                {/* Footer action buttons */}
                <div className="pt-4 border-t border-slate-100 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setShowCreateTaskModal(false)}
                    className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-600 rounded-lg text-xs font-black uppercase tracking-wider transition-colors cursor-pointer"
                  >
                    Hủy bỏ
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-black uppercase tracking-wider transition-colors cursor-pointer"
                  >
                    Tạo mới
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
