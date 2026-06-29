import { Layout } from "@/components/layout/Layout";
import { 
  useGetAiUsage, 
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function AiUsage() {
  const { data: usage, isLoading } = useGetAiUsage();

  if (isLoading) {
    return (
      <Layout>
        <div className="space-y-6">
          <h1 className="text-3xl font-bold tracking-tight">AI Usage</h1>
          <div className="text-center py-12 text-muted-foreground">Loading usage stats...</div>
        </div>
      </Layout>
    );
  }

  const callsPercent = Math.min(((usage?.callsUsed || 0) / Math.max(usage?.callsLimit || 1, 1)) * 100, 100);
  const postsPercent = Math.min(((usage?.postsGenerated || 0) / Math.max(usage?.postsLimit || 1, 1)) * 100, 100);
  
  // Rewrites logic safely handling optional fields
  const rLimit = usage?.rewritesLimit || 1;
  const rUsed = usage?.rewritesUsed || 0;
  const rewritesPercent = Math.min((rUsed / Math.max(rLimit, 1)) * 100, 100);

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">AI Cost Monitor</h1>
          <p className="text-muted-foreground mt-1">Daily limits reset at midnight UTC.</p>
        </div>

        {usage?.limitReached && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Daily limit reached</AlertTitle>
            <AlertDescription>
              You have hit one or more of your daily AI limits. Generation is paused until tomorrow.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>API Calls Limit</CardTitle>
              <CardDescription>Total requests to OpenAI today.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex justify-between items-baseline">
                  <div className="text-3xl font-bold">{usage?.callsUsed || 0}</div>
                  <div className="text-sm text-muted-foreground">of {usage?.callsLimit || 0} limit</div>
                </div>
                <Progress value={callsPercent} className={`h-3 ${callsPercent > 90 ? '[&>div]:bg-destructive' : ''}`} />
                {callsPercent > 90 && <p className="text-xs text-destructive font-medium">Approaching limit</p>}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Posts Generated</CardTitle>
              <CardDescription>Successful content generations today.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex justify-between items-baseline">
                  <div className="text-3xl font-bold">{usage?.postsGenerated || 0}</div>
                  <div className="text-sm text-muted-foreground">of {usage?.postsLimit || 0} limit</div>
                </div>
                <Progress value={postsPercent} className={`h-3 ${postsPercent > 90 ? '[&>div]:bg-destructive' : ''}`} />
                {postsPercent > 90 && <p className="text-xs text-destructive font-medium">Approaching limit</p>}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Rewrites per Post</CardTitle>
              <CardDescription>Average usage of regen capabilities.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex justify-between items-baseline">
                  <div className="text-3xl font-bold">{rUsed}</div>
                  <div className="text-sm text-muted-foreground">of {rLimit} limit</div>
                </div>
                <Progress value={rewritesPercent} className={`h-3 ${rewritesPercent > 90 ? '[&>div]:bg-destructive' : ''}`} />
              </div>
            </CardContent>
          </Card>

          <Card className={usage?.costGuardEnabled ? "border-green-500/50 bg-green-500/5" : ""}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {usage?.costGuardEnabled ? <ShieldCheck className="h-5 w-5 text-green-500" /> : <AlertTriangle className="h-5 w-5 text-yellow-500" />}
                Cost Guard Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-medium mb-2">
                {usage?.costGuardEnabled ? (
                  <span className="text-green-500">Strict limits are enabled.</span>
                ) : (
                  <span className="text-yellow-500">Limits are soft warnings only.</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                You can change this in Bot Settings. When Cost Guard is on, the bot will hard-stop generation if a limit is reached.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
