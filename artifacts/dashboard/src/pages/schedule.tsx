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
import { Clock, Save, Moon, Timer } from "lucide-react";
import { formatDate } from "@/lib/format";

const scheduleSchema = z.object({
  enabled: z.boolean(),
  autoPublish: z.boolean(),
  intervalHours: z.coerce.number().min(1).max(168),
  maxPostsPerDay: z.coerce.number().min(1).max(50),
  minPostsPerDay: z.coerce.number().min(0).max(50),
  targetPostsPerDay: z.coerce.number().min(1).max(50),
  postingTimezone: z.string().min(1),
  postingStartTime: z.string().regex(/^\d{2}:\d{2}$/),
  postingEndTime: z.string().regex(/^\d{2}:\d{2}$/),
  nightPauseEnabled: z.boolean(),
  nightPauseStart: z.string().regex(/^\d{2}:\d{2}$/),
  nightPauseEnd: z.string().regex(/^\d{2}:\d{2}$/),
  minMinutesBetweenPosts: z.coerce.number().min(5).max(480),
  maxMinutesBetweenPosts: z.coerce.number().min(5).max(480),
  randomDelayEnabled: z.boolean(),
  randomDelayMinutes: z.coerce.number().min(0).max(60),
});

type ScheduleForm = z.infer<typeof scheduleSchema>;

export default function Schedule() {
  const { data: schedule, isLoading } = useGetSchedule();
  const updateSchedule = useUpdateSchedule();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<ScheduleForm>({
    resolver: zodResolver(scheduleSchema),
    defaultValues: {
      enabled: false,
      autoPublish: false,
      intervalHours: 6,
      maxPostsPerDay: 8,
      minPostsPerDay: 6,
      targetPostsPerDay: 7,
      postingTimezone: "Europe/Kyiv",
      postingStartTime: "09:00",
      postingEndTime: "23:30",
      nightPauseEnabled: true,
      nightPauseStart: "00:00",
      nightPauseEnd: "08:30",
      minMinutesBetweenPosts: 75,
      maxMinutesBetweenPosts: 180,
      randomDelayEnabled: true,
      randomDelayMinutes: 25,
    }
  });

  useEffect(() => {
    if (schedule) {
      form.reset({
        enabled: schedule.enabled,
        autoPublish: schedule.autoPublish,
        intervalHours: schedule.intervalHours,
        maxPostsPerDay: schedule.maxPostsPerDay,
        minPostsPerDay: schedule.minPostsPerDay,
        targetPostsPerDay: schedule.targetPostsPerDay,
        postingTimezone: schedule.postingTimezone,
        postingStartTime: schedule.postingStartTime,
        postingEndTime: schedule.postingEndTime,
        nightPauseEnabled: schedule.nightPauseEnabled,
        nightPauseStart: schedule.nightPauseStart,
        nightPauseEnd: schedule.nightPauseEnd,
        minMinutesBetweenPosts: schedule.minMinutesBetweenPosts,
        maxMinutesBetweenPosts: schedule.maxMinutesBetweenPosts,
        randomDelayEnabled: schedule.randomDelayEnabled,
        randomDelayMinutes: schedule.randomDelayMinutes,
      });
    }
  }, [schedule, form]);

  const onSubmit = (data: ScheduleForm) => {
    updateSchedule.mutate({ data }, {
      onSuccess: () => {
        toast({ title: "Настройки расписания сохранены" });
        queryClient.invalidateQueries({ queryKey: getGetScheduleQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Unknown error";
        toast({ title: "Ошибка сохранения", description: msg, variant: "destructive" });
      }
    });
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Расписание публикаций</h1>
          <p className="text-muted-foreground mt-1">Настройте когда и как часто бот публикует посты.</p>
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Загрузка...</div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="grid gap-6 md:grid-cols-2">

                {/* ── Main toggles ────────────────────────────────── */}
                <Card>
                  <CardHeader>
                    <CardTitle>Основные настройки</CardTitle>
                    <CardDescription>Включение автоматизации и авто-публикации.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField control={form.control} name="enabled" render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base">Автоматизация включена</FormLabel>
                          <FormDescription>Бот будет автоматически генерировать посты по расписанию.</FormDescription>
                        </div>
                        <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="autoPublish" render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm border-orange-500/20 bg-orange-500/5">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base text-orange-500">Авто-публикация</FormLabel>
                          <FormDescription>
                            Качественные посты публикуются автоматически с соблюдением расписания и интервалов.
                            Посты с низким confidence или safety-предупреждениями идут на ревью.
                          </FormDescription>
                        </div>
                        <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="intervalHours" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Интервал генерации (часы)</FormLabel>
                        <FormControl><Input type="number" {...field} /></FormControl>
                        <FormDescription>Как часто бот ищет новые источники и генерирует посты.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </CardContent>
                </Card>

                {/* ── Status card ─────────────────────────────────── */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Clock className="h-5 w-5" /> Статус
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-muted-foreground">Последний запуск</span>
                      <span className="font-medium">{formatDate(schedule?.lastRunAt)}</span>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-muted-foreground">Следующий запуск</span>
                      <span className="font-medium text-primary">{schedule?.enabled ? formatDate(schedule?.nextRunAt) : "Отключено"}</span>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-muted-foreground">Последняя публикация</span>
                      <span className="font-medium">{formatDate(schedule?.lastPublishedAt)}</span>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-muted-foreground">Статус</span>
                      <span className={schedule?.enabled ? "text-green-500 font-bold" : "text-red-500 font-bold"}>
                        {schedule?.enabled ? "АКТИВНО" : "ПАУЗА"}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-2">
                      <span className="text-muted-foreground">Авто-публикация</span>
                      <span className={schedule?.autoPublish ? "text-orange-500 font-bold" : "text-muted-foreground"}>
                        {schedule?.autoPublish ? "ВКЛ" : "ВЫКЛ"}
                      </span>
                    </div>
                  </CardContent>
                </Card>

                {/* ── Posting window ──────────────────────────────── */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Timer className="h-5 w-5" /> Окно публикаций
                    </CardTitle>
                    <CardDescription>Посты публикуются только в это время.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField control={form.control} name="postingTimezone" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Часовой пояс</FormLabel>
                        <FormControl><Input placeholder="Europe/Kyiv" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={form.control} name="postingStartTime" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Начало (HH:MM)</FormLabel>
                          <FormControl><Input placeholder="09:00" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="postingEndTime" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Конец (HH:MM)</FormLabel>
                          <FormControl><Input placeholder="23:30" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </CardContent>
                </Card>

                {/* ── Night pause ─────────────────────────────────── */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Moon className="h-5 w-5" /> Ночная пауза
                    </CardTitle>
                    <CardDescription>Запрет публикаций в ночное время.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField control={form.control} name="nightPauseEnabled" render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm">
                        <div>
                          <FormLabel className="text-base">Ночная пауза</FormLabel>
                          <FormDescription>Не публиковать в ночное время.</FormDescription>
                        </div>
                        <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                      </FormItem>
                    )} />

                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={form.control} name="nightPauseStart" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Начало паузы</FormLabel>
                          <FormControl><Input placeholder="00:00" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="nightPauseEnd" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Конец паузы</FormLabel>
                          <FormControl><Input placeholder="08:30" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </CardContent>
                </Card>

                {/* ── Daily targets ───────────────────────────────── */}
                <Card>
                  <CardHeader>
                    <CardTitle>Дневные лимиты</CardTitle>
                    <CardDescription>Сколько постов публиковать в день.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-3 gap-3">
                      <FormField control={form.control} name="minPostsPerDay" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Мин.</FormLabel>
                          <FormControl><Input type="number" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="targetPostsPerDay" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Цель</FormLabel>
                          <FormControl><Input type="number" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="maxPostsPerDay" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Макс.</FormLabel>
                          <FormControl><Input type="number" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </CardContent>
                </Card>

                {/* ── Spacing ─────────────────────────────────────── */}
                <Card>
                  <CardHeader>
                    <CardTitle>Интервалы между постами</CardTitle>
                    <CardDescription>Естественное распределение постов в течение дня.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={form.control} name="minMinutesBetweenPosts" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Мин. интервал (мин)</FormLabel>
                          <FormControl><Input type="number" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="maxMinutesBetweenPosts" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Макс. интервал (мин)</FormLabel>
                          <FormControl><Input type="number" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>

                    <FormField control={form.control} name="randomDelayEnabled" render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm">
                        <div>
                          <FormLabel className="text-base">Случайная задержка</FormLabel>
                          <FormDescription>Добавляет случайность, чтобы посты не выходили в одно и то же время каждый день.</FormDescription>
                        </div>
                        <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="randomDelayMinutes" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Максимальная случайная задержка (мин)</FormLabel>
                        <FormControl><Input type="number" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </CardContent>
                </Card>
              </div>

              <div className="flex justify-end">
                <Button type="submit" disabled={updateSchedule.isPending} className="gap-2">
                  <Save className="h-4 w-4" />
                  {updateSchedule.isPending ? "Сохраняется..." : "Сохранить изменения"}
                </Button>
              </div>
            </form>
          </Form>
        )}
      </div>
    </Layout>
  );
}
