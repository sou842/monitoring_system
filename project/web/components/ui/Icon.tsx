import {
  Activity, ArrowDown, ArrowUp, Bell, Check, CheckCheck, ChevronDown, Eye, Folder, Ghost, Heart, House, Inbox, LayoutGrid, LogOut, Menu, MessageCircle, Moon, PanelLeft,
  PartyPopper, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Smile, Sparkles, Sun, ThumbsUp, Trash2, User, Users, X, LayoutDashboard, Clock, Copy, CircleAlert, Reply, RotateCw,
  type LucideIcon,
} from 'lucide-react';

/** Every icon the app uses, as Lucide icons (https://lucide.dev). Add new ones here, not as hand-drawn SVG paths. */
export const ICONS = {
  inbox: Inbox,
  sidebar: PanelLeft,
  ghost: Ghost,
  plus: Plus,
  close: X,
  check: Check,
  checkDouble: CheckCheck,
  search: Search,
  folder: Folder,
  dashboard: LayoutDashboard,
  performance: Activity,
  shield: ShieldCheck,
  logout: LogOut,
  refresh: RefreshCw,
  moon: Moon,
  grid: LayoutGrid,
  home: House,
  sparkle: Sparkles,
  chat: MessageCircle,
  users: Users,
  user: User,
  sliders: SlidersHorizontal,
  bell: Bell,
  chevron: ChevronDown,
  menu: Menu,
  sun: Sun,
  send: ArrowUp,
  arrowDown: ArrowDown,
  clock: Clock,
  copy: Copy,
  alert: CircleAlert,
  reply: Reply,
  retry: RotateCw,
  smile: Smile,
  trash: Trash2,
  thumbsUp: ThumbsUp,
  heart: Heart,
  party: PartyPopper,
  eye: Eye,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** A Lucide icon; size, colour and stroke come from the surrounding CSS or `className` (stroke: currentColor). */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  const Glyph = ICONS[name];
  return <Glyph aria-hidden="true" className={className} />;
}

/** The rounded icon tile of empty states. */
export function IconTile({ name }: { name: IconName }) {
  return (
    <div className="empty-icon">
      <Icon name={name} />
    </div>
  );
}
