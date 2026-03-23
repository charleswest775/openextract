import { useState } from 'react';
import { BackupInfo } from '../hooks/useBackup';
import { MessageSquare, Image, Phone, PhoneCall, Users, FileText, PanelLeftClose, PanelLeft } from 'lucide-react';
import MessageView from './MessageView';
import PhotoGallery from './photos/PhotoGallery';
import VoicemailView from './voicemail/VoicemailView';
import CallsView from './calls/CallsView';
import ContactsView from './contacts/ContactsView';
import NotesView from './notes/NotesView';

type Tab = 'messages' | 'photos' | 'voicemail' | 'calls' | 'contacts' | 'notes';

interface Props {
  backup: BackupInfo;
}

const tabs: { id: Tab; label: string; icon: typeof MessageSquare }[] = [
  { id: 'messages', label: 'Messages', icon: MessageSquare },
  { id: 'photos', label: 'Photos', icon: Image },
  { id: 'voicemail', label: 'Voicemail', icon: Phone },
  { id: 'calls', label: 'Calls', icon: PhoneCall },
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'notes', label: 'Notes', icon: FileText },
];

export default function Dashboard({ backup }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('messages');
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebar-collapsed') === 'true'; } catch { return false; }
  });

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem('sidebar-collapsed', String(next)); } catch {}
  };

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <nav
        className="flex flex-col flex-shrink-0 transition-all duration-250 ease-in-out"
        style={{
          width: collapsed ? '56px' : '180px',
          background: 'var(--bg-sidebar)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRight: '0.5px solid var(--border-default)',
        }}
      >
        <div className="px-2 pt-3 pb-1">
          {!collapsed && (
            <div className="text-caption font-semibold text-text-tertiary uppercase tracking-wide px-2.5 pb-1.5">
              Data
            </div>
          )}
        </div>

        <div className="flex flex-col gap-0.5 px-2 flex-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                title={collapsed ? tab.label : undefined}
                className={`flex items-center gap-2 rounded-md transition-all duration-200 ${
                  collapsed ? 'justify-center px-0 h-9 w-full' : 'px-2.5 h-8'
                } ${
                  isActive
                    ? 'bg-sidebar-active text-text-primary font-medium'
                    : 'text-text-secondary hover:bg-sidebar-active/50'
                }`}
              >
                <Icon
                  size={16}
                  strokeWidth={1.5}
                  className={`flex-shrink-0 transition-colors duration-200 ${
                    isActive ? 'text-text-accent' : 'text-text-tertiary'
                  }`}
                />
                {!collapsed && (
                  <span className="text-body truncate">{tab.label}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Collapse toggle */}
        <button
          onClick={toggleCollapse}
          className="flex items-center justify-center h-10 text-text-tertiary hover:text-text-secondary transition-colors duration-200"
          style={{ borderTop: '0.5px solid var(--border-default)' }}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeft size={14} strokeWidth={1.5} /> : <PanelLeftClose size={14} strokeWidth={1.5} />}
        </button>
      </nav>

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'messages' && <MessageView udid={backup.udid} />}
        {activeTab === 'photos' && <PhotoGallery backup={backup} />}
        {activeTab === 'voicemail' && <VoicemailView backup={backup} />}
        {activeTab === 'calls' && <CallsView backup={backup} />}
        {activeTab === 'contacts' && <ContactsView backup={backup} />}
        {activeTab === 'notes' && <NotesView backup={backup} />}
      </div>
    </div>
  );
}
