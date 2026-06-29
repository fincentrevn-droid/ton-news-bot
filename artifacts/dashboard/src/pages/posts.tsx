import { useState, useEffect } from "react";
import { Layout } from "@/components/layout/Layout";
import {
  useListPosts,
  getListPostsQueryKey,
  useUpdatePost,
  usePublishPost,
  useRegeneratePost,
  ListPostsStatus,
  Post,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Check, X, Send, RefreshCw, Save, Zap, Shield, Radio, Globe, SkipForward } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  published: "bg-green-500/10 text-green-500",
  draft: "bg-yellow-500/10 text-yellow-500",
  approved: "bg-blue-500/10 text-blue-500",
  rejected: "bg-red-500/10 text-red-500",
  skipped: "bg-gray-500/10 text-gray-400",
};

const SAFETY_COLORS: Record<string, string> = {
  ok: "bg-green-500/10 text-green-500",
  flagged: "bg-orange-500/10 text-orange-400",
  rejected: "bg-red-500/10 text-red-500",
};

const SOURCE_TYPE_ICON: Record<string, React.ReactNode> = {
  telegram: <Radio className="h-3 w-3" />,
  rss: <Globe className="h-3 w-3" />,
  web: <Globe className="h-3 w-3" />,
  manual: null,
};

export default function Posts() {
  const [statusFilter, setStatusFilter] = useState<ListPostsStatus | "all">("draft");
  const queryParams = statusFilter === "all" ? {} : { status: statusFilter };
  const { data: posts, isLoading } = useListPosts(queryParams);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updatePost = useUpdatePost();
  const publishPost = usePublishPost();
  const regeneratePost = useRegeneratePost();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListPostsQueryKey(queryParams) });

  const handleUpdateStatus = (id: number, status: "approved" | "rejected" | "draft" | "skipped") => {
    updatePost.mutate({ id, data: { status } }, {
      onSuccess: () => { toast({ title: `Marked as ${status}` }); invalidate(); },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "";
        toast({ title: "Failed to update", description: msg, variant: "destructive" });
      },
    });
  };

  const handlePublish = (id: number) => {
    publishPost.mutate({ id }, {
      onSuccess: () => { toast({ title: "Published to Telegram ✅" }); invalidate(); },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "";
        toast({ title: "Publish failed", description: msg, variant: "destructive" });
      },
    });
  };

  const handleRegenerate = (id: number) => {
    regeneratePost.mutate({ id }, {
      onSuccess: () => { toast({ title: "Regenerated — check Telegram for review" }); invalidate(); },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "";
        toast({ title: "Regeneration failed", description: msg, variant: "destructive" });
      },
    });
  };

  const handleSave = (id: number, content: string) => {
    updatePost.mutate({ id, data: { content } }, {
      onSuccess: () => { toast({ title: "Saved" }); invalidate(); },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "";
        toast({ title: "Save failed", description: msg, variant: "destructive" });
      },
    });
  };

  const isBusy = updatePost.isPending || publishPost.isPending || regeneratePost.isPending;

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Post Queue</h1>
          <p className="text-muted-foreground mt-1">
            Review, edit, and publish posts. Each generated post is also sent to Telegram for approval.
          </p>
        </div>

        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as ListPostsStatus | "all")}>
          <TabsList className="mb-4">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="draft">Drafts</TabsTrigger>
            <TabsTrigger value="approved">Approved</TabsTrigger>
            <TabsTrigger value="published">Published</TabsTrigger>
            <TabsTrigger value="rejected">Rejected</TabsTrigger>
            <TabsTrigger value="skipped">Skipped</TabsTrigger>
          </TabsList>
        </Tabs>

        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading...</div>
        ) : !posts?.length ? (
          <div className="text-center py-12 border border-dashed rounded-lg border-border">
            <p className="text-muted-foreground">No posts for this filter.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                onUpdateStatus={handleUpdateStatus}
                onPublish={handlePublish}
                onRegenerate={handleRegenerate}
                onSave={handleSave}
                isBusy={isBusy}
              />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

function PostCard({
  post,
  onUpdateStatus,
  onPublish,
  onRegenerate,
  onSave,
  isBusy,
}: {
  post: Post;
  onUpdateStatus: (id: number, status: "approved" | "rejected" | "draft" | "skipped") => void;
  onPublish: (id: number) => void;
  onRegenerate: (id: number) => void;
  onSave: (id: number, content: string) => void;
  isBusy: boolean;
}) {
  const [content, setContent] = useState(post.content);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => { setContent(post.content); }, [post.content]);

  const sourceIcon = SOURCE_TYPE_ICON[post.sourceType] ?? null;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-muted/30 py-3 border-b flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[post.status] ?? ""}`}>
            {post.status.toUpperCase()}
          </span>
          <span className="text-xs font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">
            {post.postType}
          </span>
          {post.sourceType !== "manual" && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground border border-border rounded px-1.5 py-0.5">
              {sourceIcon}
              {post.sourceType}
            </span>
          )}
          {post.safetyStatus !== "ok" && (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${SAFETY_COLORS[post.safetyStatus] ?? ""}`}>
              <Shield className="h-3 w-3" /> {post.safetyStatus}
            </span>
          )}
          {post.reviewMessageId && (
            <span className="text-xs text-muted-foreground">📩 in TG review</span>
          )}
          <span className="text-xs text-muted-foreground">{formatDate(post.createdAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          {post.status !== "published" && (
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => onRegenerate(post.id)} disabled={isBusy}>
              <RefreshCw className="h-3 w-3" /> Rewrite
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4">
        {post.topic && (
          <div className="mb-3 text-xs text-muted-foreground">📌 <span className="italic">{post.topic}</span></div>
        )}

        {isEditing ? (
          <div className="space-y-3">
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[150px] font-mono text-sm leading-relaxed"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setContent(post.content); setIsEditing(false); }}>Cancel</Button>
              <Button size="sm" onClick={() => { onSave(post.id, content); setIsEditing(false); }} className="gap-1">
                <Save className="h-4 w-4" /> Save
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="font-mono text-sm leading-relaxed whitespace-pre-wrap cursor-pointer p-2 rounded hover:bg-muted/50 transition-colors"
            onClick={() => setIsEditing(true)}
            title="Click to edit"
          >
            {content}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 pt-4 border-t border-border">
          {post.status === "draft" && (
            <>
              <Button size="sm" variant="outline"
                className="bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 hover:text-blue-400 border-blue-500/20"
                onClick={() => onUpdateStatus(post.id, "approved")} disabled={isBusy}>
                <Check className="h-4 w-4 mr-1" /> Approve
              </Button>
              <Button size="sm" variant="outline"
                className="bg-green-500/10 text-green-500 hover:bg-green-500/20 hover:text-green-400 border-green-500/20"
                onClick={() => onPublish(post.id)} disabled={isBusy}>
                <Send className="h-4 w-4 mr-1" /> Publish Now
              </Button>
              <Button size="sm" variant="outline"
                className="bg-red-500/10 text-red-500 hover:bg-red-500/20 hover:text-red-400 border-red-500/20"
                onClick={() => onUpdateStatus(post.id, "rejected")} disabled={isBusy}>
                <X className="h-4 w-4 mr-1" /> Reject
              </Button>
              <Button size="sm" variant="ghost"
                className="text-muted-foreground"
                onClick={() => onUpdateStatus(post.id, "skipped")} disabled={isBusy}>
                <SkipForward className="h-4 w-4 mr-1" /> Skip
              </Button>
            </>
          )}

          {post.status === "approved" && (
            <>
              <Button size="sm" className="bg-primary text-primary-foreground" onClick={() => onPublish(post.id)} disabled={isBusy}>
                <Send className="h-4 w-4 mr-1" /> Publish Now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onUpdateStatus(post.id, "draft")} disabled={isBusy}>
                Revert to Draft
              </Button>
            </>
          )}

          {(post.status === "rejected" || post.status === "skipped") && (
            <Button size="sm" variant="outline" onClick={() => onUpdateStatus(post.id, "draft")} disabled={isBusy}>
              Revert to Draft
            </Button>
          )}

          {(post.aiCallsUsed ?? 0) > 0 && (
            <div className="ml-auto text-xs text-muted-foreground flex items-center gap-1">
              <Zap className="h-3 w-3" /> {post.aiCallsUsed} AI call{post.aiCallsUsed === 1 ? "" : "s"}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
