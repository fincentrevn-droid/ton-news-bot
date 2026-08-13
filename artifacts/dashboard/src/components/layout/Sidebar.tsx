import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  FileText, 
  Rss, 
  Clock, 
  Settings as SettingsIcon, 
  Activity 
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useGetDashboardStats } from "@workspace/api-client-react";
import { useEffect } from "react";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Posts Queue", href: "/posts", icon: FileText },
  { name: "News Sources", href: "/sources", icon: Rss },
  { name: "Schedule", href: "/schedule", icon: Clock },
  { name: "Bot Settings", href: "/settings", icon: SettingsIcon },
  { name: "AI Usage", href: "/ai-usage", icon: Activity },
];

export function Sidebar() {
  const [location] = useLocation();
  const { data: stats } = useGetDashboardStats();

  useEffect(() => {
    if (!stats) return;

    const title = `${stats.channelName} — автопостинг`;
    const description = `${stats.channelSubtitle}. Канал ${stats.channelSignature}.`;
    document.title = title;

    const metadata: Record<string, string> = {
      "meta[name='description']": description,
      "meta[property='og:title']": title,
      "meta[property='og:description']": description,
      "meta[name='twitter:title']": title,
      "meta[name='twitter:description']": description,
    };

    for (const [selector, content] of Object.entries(metadata)) {
      document.querySelector<HTMLMetaElement>(selector)?.setAttribute("content", content);
    }
  }, [stats]);

  return (
    <div className="flex h-full w-64 flex-col border-r border-border bg-sidebar px-4 py-6">
      <div className="flex items-center gap-2 px-2 mb-8">
        <div className="h-8 w-8 rounded bg-primary flex items-center justify-center">
          <Activity className="h-5 w-5 text-primary-foreground" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-bold text-foreground leading-tight">{stats?.channelName ?? "News Bot"}</span>
          <span className="text-xs text-muted-foreground leading-tight">{stats?.channelSignature ?? "Автопостинг новин"}</span>
        </div>
      </div>

      <nav className="flex-1 space-y-1">
        {navigation.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.name}
            </Link>
          );
        })}
      </nav>
      
      <div className="mt-auto px-2 py-4 border-t border-border">
        <div className="text-xs text-muted-foreground text-center">
          System Online
        </div>
      </div>
    </div>
  );
}
