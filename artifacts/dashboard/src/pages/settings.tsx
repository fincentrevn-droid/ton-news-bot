import { useEffect } from "react";
import { Layout } from "@/components/layout/Layout";
import {
  useGetSettings,
  getGetSettingsQueryKey,
  useUpdateSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Save, AlertTriangle, Bot, Shield, Radio } from "lucide-react";

const settingsSchema = z.object({
  openaiModel: z.string().min(1),
  maxAiCallsPerDay: z.coerce.number().min(1).max(500),
  maxPostsPerDay: z.coerce.number().min(1).max(50),
  minPostsPerDay: z.coerce.number().min(0).max(50),
  maxRewritePerPost: z.coerce.number().min(1).max(10),
  maxTokensPerPost: z.coerce.number().min(100).max(8000),
  enableCostGuard: z.boolean(),
  autoPublish: z.boolean(),
  postingRequiresApproval: z.boolean(),
  enableSecondarySourcesi: z.boolean(),
  customEmojiEnabled: z.boolean(),
  customEmojiFallback: z.boolean(),
  ownerChatId: z.string().optional(),
  reviewChatId: z.string().optional(),
});

type FormValues = z.infer<typeof settingsSchema>;

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<FormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      openaiModel: "gpt-4o",
      maxAiCallsPerDay: 12,
      maxPostsPerDay: 6,
      minPostsPerDay: 5,
      maxRewritePerPost: 3,
      maxTokensPerPost: 1500,
      enableCostGuard: true,
      autoPublish: false,
      postingRequiresApproval: true,
      enableSecondarySourcesi: false,
      customEmojiEnabled: true,
      customEmojiFallback: true,
      ownerChatId: "",
      reviewChatId: "",
    },
  });

  const watchAutoPublish = form.watch("autoPublish");

  useEffect(() => {
    if (settings) {
      form.reset({
        openaiModel: settings.openaiModel,
        maxAiCallsPerDay: settings.maxAiCallsPerDay,
        maxPostsPerDay: settings.maxPostsPerDay,
        minPostsPerDay: settings.minPostsPerDay,
        maxRewritePerPost: settings.maxRewritePerPost,
        maxTokensPerPost: settings.maxTokensPerPost,
        enableCostGuard: settings.enableCostGuard,
        autoPublish: settings.autoPublish,
        postingRequiresApproval: settings.postingRequiresApproval,
        enableSecondarySourcesi: settings.enableSecondarySourcesi,
        customEmojiEnabled: settings.customEmojiEnabled,
        customEmojiFallback: settings.customEmojiFallback,
        ownerChatId: settings.ownerChatId ?? "",
        reviewChatId: settings.reviewChatId ?? "",
      });
    }
  }, [settings, form]);

  const onSubmit = (data: FormValues) => {
    updateSettings.mutate({ data }, {
      onSuccess: () => {
        toast({ title: "Settings saved" });
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "";
        toast({ title: "Save failed", description: msg, variant: "destructive" });
      },
    });
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Bot Settings</h1>
          <p className="text-muted-foreground mt-1">Configure model, limits, approval flow, and Telegram integration.</p>
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading settings...</div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 max-w-3xl">

              {/* AI Model */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5" /> AI Configuration</CardTitle>
                  <CardDescription>Model selection and generation parameters.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField control={form.control} name="openaiModel" render={({ field }) => (
                    <FormItem>
                      <FormLabel>OpenAI Model</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger><SelectValue placeholder="Select model" /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="gpt-4o">gpt-4o — Best quality</SelectItem>
                          <SelectItem value="gpt-4o-mini">gpt-4o-mini — Faster, cheaper fallback</SelectItem>
                          <SelectItem value="gpt-4-turbo">gpt-4-turbo — Previous generation</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        The OPENAI_MODEL environment variable always overrides this.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <div className="grid gap-4 md:grid-cols-2">
                    <FormField control={form.control} name="maxTokensPerPost" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Max Tokens Per Post</FormLabel>
                        <FormControl><Input type="number" {...field} /></FormControl>
                        <FormDescription>Max output length (default 1500).</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="maxRewritePerPost" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Max Rewrites Per Post</FormLabel>
                        <FormControl><Input type="number" {...field} /></FormControl>
                        <FormDescription>Prevents infinite rewrite loops.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                </CardContent>
              </Card>

              {/* Approval flow */}
              <Card>
                <CardHeader>
                  <CardTitle>Approval Flow</CardTitle>
                  <CardDescription>Controls how posts are reviewed before publishing.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField control={form.control} name="postingRequiresApproval" render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm border-border">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">Posting Requires Approval</FormLabel>
                        <FormDescription>
                          Each generated post is sent to Telegram for ✅/🔁/❌ review before publishing.
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="autoPublish" render={({ field }) => (
                    <FormItem className={`flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm ${field.value ? "border-orange-500/30 bg-orange-500/5" : "border-border"}`}>
                      <div className="space-y-0.5">
                        <FormLabel className={`text-base ${field.value ? "text-orange-400" : ""}`}>
                          Auto-publish
                        </FormLabel>
                        <FormDescription>
                          {field.value
                            ? "⚠️ Posts will be published to the channel without any manual review."
                            : "When disabled, posts wait in the queue until manually approved."}
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )} />

                  {watchAutoPublish && (
                    <div className="flex items-start gap-3 rounded-md bg-orange-500/10 border border-orange-500/20 px-4 py-3 text-sm text-orange-400">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <span>Auto-publish is <strong>ON</strong>. AI-generated posts will be sent to the channel without manual approval. Only enable this when you are confident in content quality.</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Cost guard */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Shield className="h-5 w-5 text-yellow-500" /> Cost Guard & Limits</CardTitle>
                  <CardDescription>Daily limits to prevent unexpected API costs.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField control={form.control} name="enableCostGuard" render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm border-primary/20 bg-primary/5">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base text-primary">Cost Guard</FormLabel>
                        <FormDescription>Strictly enforce daily limits and stop generation when reached.</FormDescription>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )} />

                  <div className="grid gap-4 md:grid-cols-2">
                    <FormField control={form.control} name="maxAiCallsPerDay" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Max AI Calls / Day</FormLabel>
                        <FormControl><Input type="number" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="maxPostsPerDay" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Max Posts / Day</FormLabel>
                        <FormControl><Input type="number" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="minPostsPerDay" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Min Posts / Day</FormLabel>
                        <FormControl><Input type="number" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                </CardContent>
              </Card>

              {/* Sources */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Radio className="h-5 w-5 text-blue-400" /> Sources</CardTitle>
                </CardHeader>
                <CardContent>
                  <FormField control={form.control} name="enableSecondarySourcesi" render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm border-border">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">Enable Secondary Sources</FormLabel>
                        <FormDescription>
                          Use RSS/web sources when primary Telegram sources are insufficient.
                          Default: OFF — Telegram channels are always primary.
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )} />
                </CardContent>
              </Card>

              {/* Emoji */}
              <Card>
                <CardHeader>
                  <CardTitle>Custom Emoji</CardTitle>
                  <CardDescription>Telegram Premium custom emoji support.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField control={form.control} name="customEmojiEnabled" render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm border-border">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">Custom Emoji Enabled</FormLabel>
                        <FormDescription>Use Telegram Premium custom emoji in posts when available.</FormDescription>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="customEmojiFallback" render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm border-border">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">Fallback to Unicode Emoji</FormLabel>
                        <FormDescription>If custom emoji is unavailable, use standard Unicode emoji instead.</FormDescription>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )} />
                </CardContent>
              </Card>

              {/* Telegram */}
              <Card>
                <CardHeader>
                  <CardTitle>Telegram Integration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField control={form.control} name="ownerChatId" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Owner Telegram ID</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 123456789" {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormDescription>Your personal Telegram user ID — receives critical alerts.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="reviewChatId" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Review Chat ID</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 123456789 or @groupname" {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormDescription>
                        Where new drafts are sent with ✅/🔁/❌ buttons for review.
                        Falls back to Owner Telegram ID if not set.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                </CardContent>
                <CardFooter className="border-t pt-6 bg-muted/20 flex justify-end">
                  <Button type="submit" disabled={updateSettings.isPending} className="gap-2">
                    <Save className="h-4 w-4" />
                    {updateSettings.isPending ? "Saving..." : "Save Settings"}
                  </Button>
                </CardFooter>
              </Card>
            </form>
          </Form>
        )}
      </div>
    </Layout>
  );
}
