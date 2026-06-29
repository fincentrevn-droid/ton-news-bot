import { useState } from "react";
import { Layout } from "@/components/layout/Layout";
import {
  useListSources,
  getListSourcesQueryKey,
  useCreateSource,
  useUpdateSource,
  useDeleteSource,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Rss, MessageCircle, Link as LinkIcon, Radio, Star } from "lucide-react";
import { formatDate } from "@/lib/format";

const sourceSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().min(1, "URL or handle is required"),
  type: z.enum(["rss", "telegram_channel", "manual"]),
  isPrimary: z.boolean().default(false),
  category: z.string().optional(),
  enabled: z.boolean().default(true),
});

type SourceFormValues = z.infer<typeof sourceSchema>;

export default function Sources() {
  const { data: sources, isLoading } = useListSources();
  const createSource = useCreateSource();
  const updateSource = useUpdateSource();
  const deleteSource = useDeleteSource();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isAddOpen, setIsAddOpen] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListSourcesQueryKey() });

  const handleToggleEnable = (id: number, enabled: boolean) => {
    updateSource.mutate({ id, data: { enabled } }, {
      onSuccess: () => { toast({ title: `Source ${enabled ? "enabled" : "disabled"}` }); invalidate(); },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    });
  };

  const handleTogglePrimary = (id: number, isPrimary: boolean) => {
    updateSource.mutate({ id, data: { isPrimary } }, {
      onSuccess: () => { toast({ title: isPrimary ? "Set as primary source" : "Set as secondary source" }); invalidate(); },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    });
  };

  const handleDelete = (id: number) => {
    deleteSource.mutate({ id }, {
      onSuccess: () => { toast({ title: "Source removed" }); invalidate(); },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "";
        toast({ title: "Delete failed", description: msg, variant: "destructive" });
      },
    });
  };

  const primarySources = sources?.filter((s) => s.isPrimary) ?? [];
  const secondarySources = sources?.filter((s) => !s.isPrimary) ?? [];

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">News Sources</h1>
            <p className="text-muted-foreground mt-1">
              Telegram channels are <strong>primary</strong>. RSS/web feeds are secondary (off by default).
            </p>
          </div>
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="h-4 w-4" /> Add Source</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add News Source</DialogTitle>
              </DialogHeader>
              <SourceForm
                onSubmit={(data) => {
                  createSource.mutate({ data }, {
                    onSuccess: () => { toast({ title: "Source added" }); setIsAddOpen(false); invalidate(); },
                    onError: (err: unknown) => {
                      const msg = err instanceof Error ? err.message : "";
                      toast({ title: "Failed to add source", description: msg, variant: "destructive" });
                    },
                  });
                }}
                isSubmitting={createSource.isPending}
              />
            </DialogContent>
          </Dialog>
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading sources...</div>
        ) : !sources?.length ? (
          <div className="text-center py-12 border border-dashed rounded-lg border-border">
            <p className="text-muted-foreground">No sources added yet.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Primary sources */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Radio className="h-4 w-4 text-blue-400" />
                <h2 className="text-base font-semibold">Primary Sources — Telegram Channels</h2>
                <Badge variant="secondary">{primarySources.length}</Badge>
              </div>
              {primarySources.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No primary Telegram sources. Add a Telegram channel and mark it as primary.
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {primarySources.map((source) => (
                    <SourceCard
                      key={source.id}
                      source={source}
                      onToggleEnable={handleToggleEnable}
                      onTogglePrimary={handleTogglePrimary}
                      onDelete={handleDelete}
                      isPending={updateSource.isPending}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Secondary sources */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Rss className="h-4 w-4 text-orange-400" />
                <h2 className="text-base font-semibold">Secondary Sources — RSS / Web</h2>
                <Badge variant="secondary">{secondarySources.length}</Badge>
                <span className="text-xs text-muted-foreground">(used only when ENABLE_SECONDARY_SOURCES=true)</span>
              </div>
              {secondarySources.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No secondary sources. These are off by default.
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {secondarySources.map((source) => (
                    <SourceCard
                      key={source.id}
                      source={source}
                      onToggleEnable={handleToggleEnable}
                      onTogglePrimary={handleTogglePrimary}
                      onDelete={handleDelete}
                      isPending={updateSource.isPending}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

function SourceCard({
  source,
  onToggleEnable,
  onTogglePrimary,
  onDelete,
  isPending,
}: {
  source: {
    id: number;
    name: string;
    url: string;
    type: string;
    isPrimary: boolean;
    enabled: boolean;
    category?: string | null;
    lastFetchedAt?: string | null;
  };
  onToggleEnable: (id: number, enabled: boolean) => void;
  onTogglePrimary: (id: number, isPrimary: boolean) => void;
  onDelete: (id: number) => void;
  isPending: boolean;
}) {
  return (
    <Card className={!source.enabled ? "opacity-60" : ""}>
      <CardHeader className="pb-3 flex flex-row items-start justify-between space-y-0 relative pr-12">
        <div className="space-y-1">
          <CardTitle className="text-base flex items-center gap-2">
            {source.type === "rss" && <Rss className="h-4 w-4 text-orange-500" />}
            {source.type === "telegram_channel" && <MessageCircle className="h-4 w-4 text-blue-500" />}
            {source.type === "manual" && <LinkIcon className="h-4 w-4 text-gray-500" />}
            {source.name}
            {source.isPrimary && <Star className="h-3 w-3 text-yellow-400 fill-yellow-400" />}
          </CardTitle>
          <CardDescription className="line-clamp-1 text-xs" title={source.url}>
            {source.url}
          </CardDescription>
          {source.category && (
            <span className="inline-block text-xs bg-muted text-muted-foreground rounded px-1.5 py-0.5">{source.category}</span>
          )}
        </div>
        <div className="absolute right-4 top-4">
          <Switch
            checked={source.enabled}
            onCheckedChange={(val) => onToggleEnable(source.id, val)}
            disabled={isPending}
          />
        </div>
      </CardHeader>
      <CardContent className="pt-0 flex items-end justify-between gap-2">
        <div className="text-xs text-muted-foreground space-y-1">
          <div>Last fetched: {formatDate(source.lastFetchedAt)}</div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 text-xs ${source.isPrimary ? "text-yellow-400 hover:text-yellow-300" : "text-muted-foreground"}`}
            onClick={() => onTogglePrimary(source.id, !source.isPrimary)}
            disabled={isPending}
            title={source.isPrimary ? "Remove from primary" : "Set as primary"}
          >
            <Star className={`h-3 w-3 ${source.isPrimary ? "fill-yellow-400" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDelete(source.id)}
            className="h-7 w-7 text-destructive hover:text-destructive/90 hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SourceForm({
  onSubmit,
  isSubmitting,
}: {
  onSubmit: (data: SourceFormValues) => void;
  isSubmitting?: boolean;
}) {
  const form = useForm<SourceFormValues>({
    resolver: zodResolver(sourceSchema),
    defaultValues: { name: "", url: "", type: "telegram_channel", isPrimary: true, category: "", enabled: true },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl><Input placeholder="e.g. TON Blockchain" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="type" render={({ field }) => (
          <FormItem>
            <FormLabel>Type</FormLabel>
            <Select onValueChange={field.onChange} defaultValue={field.value}>
              <FormControl>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="telegram_channel">Telegram Channel (Primary)</SelectItem>
                <SelectItem value="rss">RSS Feed (Secondary)</SelectItem>
                <SelectItem value="manual">Manual URL</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="url" render={({ field }) => (
          <FormItem>
            <FormLabel>URL or Handle</FormLabel>
            <FormControl><Input placeholder="https://... or @channel" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="category" render={({ field }) => (
          <FormItem>
            <FormLabel>Category (Optional)</FormLabel>
            <FormControl><Input placeholder="e.g. TON, Market, Telegram" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="isPrimary" render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <FormLabel className="text-sm">Mark as Primary Source</FormLabel>
              <p className="text-xs text-muted-foreground">Primary sources are always used. Secondary sources need ENABLE_SECONDARY_SOURCES=true.</p>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )} />

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Adding..." : "Add Source"}
        </Button>
      </form>
    </Form>
  );
}
