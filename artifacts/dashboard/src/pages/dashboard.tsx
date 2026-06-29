import { Layout } from "@/components/layout/Layout";
import {
  useGetDashboardStats,
  useGetAiUsage,
  useListPosts,
  useTriggerGeneration,
  useGetSettings,
  useUpdateSettings,
  getListPostsQueryKey,
  getGetDashboardStatsQueryKey,
  getGetSettingsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Activity, FileText, CheckCircle, Clock, Zap, Shield, Bot,
  AlertTriangle, TrendingUp, Eye, MessageSquare, Repeat2, Link2,
} from "lucide-react";
import { formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

const STATUS_COLORS: Record<string, string> = {
  published: "bg-green-500/10 text-green-500",
  draft: "bg-yellow-500/10 text-yellow-500",
  approved: "bg-blue-500/10 text-blue-500",
  rejected: "bg-red-500/10 text-red-500",
  skipped: "bg-gray-500/10 text-gray-400",
};

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: aiUsage, isLoading: aiLoading } = useGetAiUsage();
  const { data: settings, isLoading: settingsLoading } = useGetSettings();
  const { data: recentPosts, isLoading: postsLoading } = useListPosts({ limit: 5 });
  const triggerGen = useTriggerGeneration();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleGenerate = () => {
    triggerGen.mutate(undefined, {
      onSuccess: (res) => {
        toast({ title: "Generation triggered", description: res.message || "Posts are being generated." });
        queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListPostsQueryKey({ limit: 5 }) });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to trigger generation";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    });
  };

  const handleToggle = (field: "autoPublish" | "messageSignature", current: boolean) => {
    updateSettings.mutate(
      { data: { [field]: !current } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to update setting", variant: "destructive" });
        },
      },
    );
  };

  const aiPct = ((aiUsage?.callsUsed ?? 0) / Math.max(aiUsage?.callsLimit ?? 1, 1)) * 100;
  const postsPct = ((aiUsage?.postsGenerated ?? 0) / Math.max(aiUsage?.postsLimit ?? 1, 1)) * 100;
  const isUpdating = updateSettings.isPending;

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">TONKOFF</h1>
            <p className="text-muted-foreground mt-1">Telegram channel dashboard</p>
          </div>
          <Button onClick={handleGenerate} disabled={triggerGen.isPending} className="gap-2">
            <Zap className="h-4 w-4" />
            {triggerGen.isPending ? "Generating..." : "Generate Now"}
          </Button>
        </div>

        {/* Top row — Channel analytics (placeholders, ready for future integration) */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AnalyticCard
            label="Subscriber Growth (24h)"
            icon={<TrendingUp className="h-4 w-4 text-emerald-400" />}
          />
          <AnalyticCard
            label="Avg Post Views (24h)"
            icon={<Eye className="h-4 w-4 text-blue-400" />}
          />
          <AnalyticCard
            label="Avg Comments (24h)"
            icon={<MessageSquare className="h-4 w-4 text-purple-400" />}
          />
          <AnalyticCard
            label="Post Forwards (24h)"
            icon={<Repeat2 className="h-4 w-4 text-sky-400" />}
          />
        </div>

        {/* Bottom row — Bot controls */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* Auto-publish toggle */}
          <Card className={settings?.autoPublish ? "border-orange-500/30 bg-orange-500/5" : ""}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">Auto-publish</span>
                <Switch
                  checked={settings?.autoPublish ?? false}
                  disabled={settingsLoading || isUpdating}
                  onCheckedChange={() => handleToggle("autoPublish", settings?.autoPublish ?? false)}
                />
              </div>
              <div className="text-lg font-bold">{settingsLoading ? "…" : (settings?.autoPublish ? "ON" : "OFF")}</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {settings?.autoPublish ? "⚠️ Posts publish without review" : "Manual approval required"}
              </p>
            </CardContent>
          </Card>

          {/* Published Today */}
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">Published Today</span>
                <CheckCircle className="h-4 w-4 text-green-400" />
              </div>
              <div className="text-lg font-bold">{statsLoading ? "–" : (stats?.publishedToday ?? 0)}</div>
              <p className="text-xs text-muted-foreground mt-0.5">Sent to Telegram channel</p>
            </CardContent>
          </Card>

          {/* AI Model */}
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">AI Model</span>
                <Bot className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-lg font-bold font-mono truncate">
                {statsLoading ? "…" : (stats?.currentModel ?? "unknown")}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">Currently active</p>
            </CardContent>
          </Card>

          {/* Message Signature toggle */}
          <Card className={settings?.messageSignature ? "border-blue-500/20 bg-blue-500/5" : ""}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">Message Signature</span>
                <Switch
                  checked={settings?.messageSignature ?? false}
                  disabled={settingsLoading || isUpdating}
                  onCheckedChange={() => handleToggle("messageSignature", settings?.messageSignature ?? false)}
                />
              </div>
              <div className="text-lg font-bold">{settingsLoading ? "…" : (settings?.messageSignature ? "ON" : "OFF")}</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                <Link2 className="inline h-3 w-3 mr-0.5 -mt-px" />
                Social links under posts
              </p>
            </CardContent>
          </Card>
        </div>

        {/* AI usage */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">AI Usage Today</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {aiLoading ? (
              <div className="text-muted-foreground text-sm">Loading...</div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>API calls</span>
                    <span className="font-mono">{aiUsage?.callsUsed ?? 0} / {aiUsage?.callsLimit ?? 0}</span>
                  </div>
                  <Progress value={aiPct} className="h-2" />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Posts generated</span>
                    <span className="font-mono">{aiUsage?.postsGenerated ?? 0} / {aiUsage?.postsLimit ?? 0}</span>
                  </div>
                  <Progress value={postsPct} className="h-2" />
                </div>
              </div>
            )}
            {aiUsage?.limitReached && (
              <div className="mt-3 flex items-center gap-2 rounded-md bg-orange-500/10 border border-orange-500/20 px-3 py-2 text-sm text-orange-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Daily limit reached — generation is paused until tomorrow.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent posts */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold tracking-tight">Recent Activity</h2>
            <Link href="/posts" className="text-sm text-primary hover:underline">View all →</Link>
          </div>
          <Card>
            <div className="divide-y divide-border">
              {postsLoading ? (
                <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
              ) : !recentPosts?.length ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No posts yet. Click <strong>Generate Now</strong> to create the first one.
                </div>
              ) : (
                recentPosts.map((post) => (
                  <div key={post.id} className="p-4 flex items-center justify-between hover:bg-muted/50 transition-colors">
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[post.status] ?? ""}`}>
                          {post.status.toUpperCase()}
                        </span>
                        <span className="text-xs font-mono text-muted-foreground">{post.postType}</span>
                        {post.safetyStatus !== "ok" && (
                          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs bg-orange-500/10 text-orange-400">
                            <Shield className="h-3 w-3" /> {post.safetyStatus}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">{formatDate(post.createdAt)}</span>
                      </div>
                      <p className="text-sm font-medium line-clamp-1">{post.content}</p>
                    </div>
                    <Link href="/posts" className="shrink-0 ml-4">
                      <Button variant="outline" size="sm">View</Button>
                    </Link>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
    </Layout>
  );
}

// Placeholder card for channel analytics not yet connected
function AnalyticCard({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          {icon}
        </div>
        <div className="text-lg font-bold text-muted-foreground">—</div>
        <p className="text-xs text-muted-foreground/60 mt-0.5">Analytics not connected</p>
      </CardContent>
    </Card>
  );
}
