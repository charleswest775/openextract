import {
  ArchiveRestore, ArrowLeft, BookUser, Briefcase, CalendarDays, ChevronRight, Clock, Download, FolderOpen,
  Globe, House, Image, LayoutGrid, LifeBuoy, Lock, MessageCircle, MessagesSquare, NotebookPen, Phone, Play, Plus, Search,
  Settings, Smartphone, Users, Voicemail,
  type LucideIcon,
} from 'lucide-react';

interface IconProps {
  className?: string;
  size?: number;
}

// The app's icons all come from one family (Lucide); index.css sets one stroke
// weight for every Lucide icon, including the ones imported directly. Each kind
// of data gets its own glyph, so no two places in the navigation look alike.
function icon(Glyph: LucideIcon) {
  return function Icon({ className, size = 20 }: IconProps) {
    return <Glyph className={className} size={size} aria-hidden="true" />;
  };
}

// Places and data
export const ChartIcon = icon(LayoutGrid); // Backup details
export const LinesIcon = icon(MessageCircle); // Messages
// Lucide has no brand icons, and WhatsApp's mark isn't ours to use: two speech bubbles, unlike Messages' one
export const WhatsAppIcon = icon(MessagesSquare);
export const CameraIcon = icon(Image); // Photos
export const ContactIcon = icon(BookUser); // Address book
export const PeopleIcon = icon(Users); // who you were in touch with
export const CallIcon = icon(Phone);
export const VoicemailIcon = icon(Voicemail);
export const NoteIcon = icon(NotebookPen);
export const GlobeIcon = icon(Globe); // Safari history
export const ClockIcon = icon(Clock); // Timeline
export const CalendarIcon = icon(CalendarDays); // Year
export const RecoverIcon = icon(ArchiveRestore);

// Actions
export const ExportIcon = icon(Download); // Save to this computer
export const DownloadIcon = icon(Download);
export const PlusIcon = icon(Plus);
export const SearchIcon = icon(Search);
export const SettingsIcon = icon(Settings);
export const HelpIcon = icon(LifeBuoy); // Help and feedback
export const HomeIcon = icon(House); // the backup's home page
export const ArrowLeftIcon = icon(ArrowLeft);
export const ChevronRightIcon = icon(ChevronRight);
export const PlayIcon = icon(Play);

// Things
export const PhoneIcon = icon(Smartphone); // the device, not a call
export const FolderIcon = icon(FolderOpen);
export const CaseIcon = icon(Briefcase);
export const LockIcon = icon(Lock);
export const GridIcon = icon(LayoutGrid);
