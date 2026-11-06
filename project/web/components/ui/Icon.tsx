import {
  Activity, ArrowDown, ArrowUp, Bell, Check, CheckCheck, ChevronDown, Eye, Folder, Ghost, Heart, House, Inbox, LayoutGrid, LogOut, Menu, MessageCircle, Moon, PanelLeft,
  Bomb, Bug, Cpu, FileJson, FileSearch, Gauge, Globe, Hourglass, ImageOff, MemoryStick, MessageSquare, OctagonPause, ServerCrash, ShieldAlert, SquareDashed, Terminal, Timer, WifiOff,
  PartyPopper, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Smile, Sparkles, Sun, ThumbsUp, Trash, Trash2, Wrench, User, Users, X, LayoutDashboard, Clock, Copy, CircleAlert, Reply, RotateCw,
  Bold, Italic, Pencil, Strikethrough, Code, SquareCode, SmilePlus, Hash, AtSign, Ellipsis, Link, Quote, List, ListOrdered, Type, RemoveFormatting,
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
  trashPlain: Trash,
  pencil: Pencil,
  wrench: Wrench,
  thumbsUp: ThumbsUp,
  heart: Heart,
  party: PartyPopper,
  eye: Eye,
  // Chat composer and message actions
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  code: Code,
  codeBlock: SquareCode,
  quote: Quote,
  smilePlus: SmilePlus,
  hash: Hash,
  at: AtSign,
  more: Ellipsis,
  link: Link,
  list: List,
  listOrdered: ListOrdered,
  format: Type,
  clearFormat: RemoveFormatting,
  // Issue kinds (chat issue cards)
  bug: Bug,
  bomb: Bomb,
  serverCrash: ServerCrash,
  wifiOff: WifiOff,
  fileJson: FileJson,
  imageOff: ImageOff,
  shieldAlert: ShieldAlert,
  cpu: Cpu,
  terminal: Terminal,
  fileSearch: FileSearch,
  blankPage: SquareDashed,
  hourglass: Hourglass,
  timer: Timer,
  memory: MemoryStick,
  octagonPause: OctagonPause,
  gauge: Gauge,
  globe: Globe,
  messageSquare: MessageSquare,
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
