import { useEffect } from "react";
import { Layout } from "@/components/layout/Layout";
import { 
  useGetSchedule, 
  getGetScheduleQueryKey,
  useUpdateSchedule
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Clock, Save } from "lucide-react";
import { formatDate } from "@/lib/format";

const scheduleSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.coerce.number().min(1).max(168),
  maxPostsPerDay: z.coerce.number().min(1).max(50),
  autoPublish: z.boolean()
});

export default function Schedule() {
  const { data: schedule, isLoading } = useGetSchedule();
  const updateSchedule = useUpdateSchedule();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm({
    resolver: zodResolver(scheduleSchema),
    defaultValues: {
      enabled: false,
      intervalHours: 6,
      maxPostsPerDay: 5,
      autoPublish: false
    }
  });

  useEffect(() => {
    if (schedule) {
      form.reset({
        enabled: schedule.enabled,
        intervalHours: schedule.intervalHours,
        maxPostsPerDay: schedule.maxPostsPerDay,
        autoPublish: schedule.autoPublish
      });
    }
  }, [schedule, form]);

  const onSubmit = (data: z.infer<typeof scheduleSchema>) => {
    updateSchedule.mutate({ data }, {
      onSuccess: () => {
        toast({ title: "Schedule updated successfully" });
        queryClient.invalidateQueries({ queryKey: getGetScheduleQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Failed to update schedule", description: err.message, variant: "destructive" });
      }
    });
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Automation Schedule</h1>
          <p className="text-muted-foreground mt-1">Configure when and how often the bot generates posts.</p>
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading schedule...</div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Schedule Settings</CardTitle>
                <CardDescription>Control the automated content generation pipeline.</CardDescription>
              </CardHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)}>
                  <CardContent className="space-y-6">
                    <FormField
                      control={form.control}
                      name="enabled"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base">Enable Automation</FormLabel>
                            <FormDescription>
                              When enabled, the bot will automatically run on schedule.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="autoPublish"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm border-orange-500/20 bg-orange-500/5">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base text-orange-500">Auto-Publish</FormLabel>
                            <FormDescription>
                              DANGEROUS: If enabled, generated posts will bypass the draft state and be sent to Telegram immediately.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="intervalHours"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Run Interval (Hours)</FormLabel>
                          <FormControl>
                            <Input type="number" {...field} />
                          </FormControl>
                          <FormDescription>
                            How often the bot wakes up to generate new content.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="maxPostsPerDay"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Max Posts Per Day</FormLabel>
                          <FormControl>
                            <Input type="number" {...field} />
                          </FormControl>
                          <FormDescription>
                            Hard limit on how many posts can be scheduled per day to avoid spamming.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                  <CardFooter className="border-t pt-6 bg-muted/20">
                    <Button type="submit" disabled={updateSchedule.isPending} className="gap-2 w-full sm:w-auto">
                      <Save className="h-4 w-4" /> 
                      {updateSchedule.isPending ? "Saving..." : "Save Changes"}
                    </Button>
                  </CardFooter>
                </form>
              </Form>
            </Card>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="h-5 w-5" /> Status
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-muted-foreground">Last Run</span>
                    <span className="font-medium">{formatDate(schedule?.lastRunAt)}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-muted-foreground">Next Run</span>
                    <span className="font-medium text-primary">{schedule?.enabled ? formatDate(schedule?.nextRunAt) : "Disabled"}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b">
                    <span className="text-muted-foreground">State</span>
                    <span className={schedule?.enabled ? "text-green-500 font-bold" : "text-red-500 font-bold"}>
                      {schedule?.enabled ? "ACTIVE" : "PAUSED"}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
