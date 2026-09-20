import { Link, useLocation } from '@tanstack/react-router';
import {
  Bell,
  Brain,
  Cpu,
  FileText,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Settings,
  Shield,
  Sticker,
  Zap,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

interface NavGroup {
  label: string;
  items: NavItem[];
}

interface NavItem {
  title: string;
  url: string;
  icon: typeof LayoutDashboard;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Observe',
    items: [
      { title: 'Overview', url: '/', icon: LayoutDashboard },
      { title: 'Tool sessions', url: '/invocations', icon: Zap },
      { title: 'Contexts', url: '/contexts', icon: MessageSquare },
      { title: 'Messages', url: '/messages', icon: FileText },
      { title: 'Bot sticker sets', url: '/stickers', icon: Sticker },
    ],
  },
  {
    label: 'Manage',
    items: [
      { title: 'Alarms', url: '/alarms', icon: Bell },
      { title: 'Memories', url: '/memories', icon: Brain },
      { title: 'Bot admins', url: '/admins', icon: Shield },
      { title: 'Models', url: '/models', icon: Cpu },
    ],
  },
  {
    label: 'Account',
    items: [{ title: 'Settings', url: '/settings', icon: Settings }],
  },
];

export default function AppSidebar({
  username,
  onSignOut,
}: {
  readonly username: string;
  readonly onSignOut: () => void;
}) {
  const { pathname } = useLocation();

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/" aria-label="Plastic Wan Admin">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 shrink-0 items-center justify-center rounded-md">
                  <Zap className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Plastic Wan</span>
                  <span className="text-muted-foreground truncate text-xs">Admin</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="overflow-x-hidden">
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="py-0">
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = item.url === '/' ? pathname === '/' : pathname.startsWith(item.url);
                return (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild tooltip={item.title} isActive={isActive}>
                      <Link to={item.url} aria-label={item.title}>
                        <Icon className="size-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <button type="button" onClick={onSignOut} className="flex w-full items-center gap-2">
                <div className="bg-muted flex aspect-square size-8 shrink-0 items-center justify-center rounded-full">
                  <LogOut className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{username}</span>
                  <span className="text-muted-foreground truncate text-xs">Sign out</span>
                </div>
              </button>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
