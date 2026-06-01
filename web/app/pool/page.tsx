import { Navigation } from "@/components/Navigation";
import { PoolTemplatesTable } from "@/components/PoolTemplatesTable";

export const metadata = {
  title: "Pool — m1n3 Protocol",
  description: "On-chain mining job templates registered by the m1n3 pool operator",
};

export default function PoolPage() {
  return (
    <>
      <Navigation />
      <main className="min-h-screen bg-background">
        <div className="mx-auto max-w-screen-2xl px-4 pt-8 pb-20">
          <div className="mb-6">
            <h1 className="font-mono text-lg font-semibold tracking-tight text-foreground">
              Pool Templates
            </h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              Mining job templates registered on-chain via{" "}
              <code className="rounded bg-muted px-1 py-0.5">pool::post_job</code>
              {" "}· each row is a Bitcoin block template the bridge posted to Sui
            </p>
          </div>
          <PoolTemplatesTable />
        </div>
      </main>
    </>
  );
}
