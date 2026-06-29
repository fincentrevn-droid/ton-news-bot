import { Layout } from "@/components/layout/Layout";
import {
  useGetDashboardStats,
  useGetAiUsage,
  useListPosts,
  useTriggerGeneration,
  getListPostsQueryKey,
  getGetDashboardStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Activity, FileText, CheckCircle, Clock, Zap, Shield, Bot, Radio,
  AlertTriangle, Eye, ToggleLeft, ToggleRight,
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
  const { data: recentPosts, isLoading: postsLoading } = useListPosts({ limit: 5 });
  const triggerGen = useTriggerGeneration();
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

  const aiPct = ((aiUsage?.callsUsed ?? 0) / Math.max(aiUsage?.callsLimit ?? 1, 1)) * 100;
  const postsPct = ((aiUsage?.postsGenerated ?? 0) / Math.max(aiUsage?.postsLimit ?? 1, 1)) * 100;

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground mt-1">TON News Bot — overview and quick actions.</p>
          </div>
          <Button onClick={handleGenerate} disabled={triggerGen.isPending} className="gap-2">
            <Zap className="h-4 w-4" />
            {triggerGen.isPending ? "Generating..." : "Generate Now"}
          </Button>
        </div>

        {/* Status bar */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatusBadgeCard
            label="AI Model"
            value={statsLoading ? "…" : (stats?.currentModel ?? "unknown")}
            icon={<Bot className="h-4 w-4" />}
            sub="Currently active"
          />
          <StatusBadgeCard
            label="Auto-publish"
            value={statsLoading ? "…" : (stats?.autoPublish ? "ON" : "OFF")}
            icon={stats?.autoPublish ? <ToggleRight className="h-4 w-4 text-orange-400" /> : <ToggleLeft className="h-4 w-4 text-muted-foreground" />}
            sub={stats?.autoPublish ? "⚠️ Posts publish without review" : "Manual approval required"}
            highlight={stats?.autoPublish}
          />
          <StatusBadgeCard
            label="Telegram Sources"
            value={statsLoading ? "…" : String(stats?.telegramSourcesCount ?? 0)}
            icon={<Radio className="h-4 w-4 text-blue-400" />}
            sub={`Secondary ${stats?.secondarySourcesEnabled ? "enabled" : "disabled"}`}
          />
          <StatusBadgeCard
            label="Pending Review"
            value={statsLoading ? "…" : String(stats?.pendingReview ?? 0)}
            icon={<Eye className="h-4 w-4 text-yellow-400" />}
            sub="In Telegram review queue"
          />
        </div>

        {/* Metric cards */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Drafts</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{statsLoading ? "–" : stats?.drafts ?? 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Awaiting action</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Published Today</CardTitle>
              <CheckCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{statsLoading ? "–" : stats?.publishedToday ?? 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Sent to Telegram channel</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Safety Rejected</CardTitle>
              <Shield className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{statsLoading ? "–" : stats?.safetyRejected ?? 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Blocked as scam/suspicious</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Posts</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{statsLoading ? "–" : stats?.totalPosts ?? 0}</div>
              <p className="text-xs text-muted-foreground mt-1">All time</p>
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

function StatusBadgeCard({
  label, value, icon, sub, highlight,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <Card className={highlight ? "border-orange-500/30 bg-orange-500/5" : ""}>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          {icon}
        </div>
        <div className="text-lg font-bold">{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}
