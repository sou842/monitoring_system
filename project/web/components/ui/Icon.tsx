import {
  Activity, ArrowUp, Bell, Check, ChevronDown, Folder, Ghost, House, Inbox, LayoutGrid, LogOut, Menu, MessageCircle, Moon, PanelLeft,
  Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Sparkles, Sun, User, Users, X, LayoutDashboard,
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
