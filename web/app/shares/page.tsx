import { Navigation } from "@/components/Navigation";
import { SharesTable } from "@/components/SharesTable";

export const metadata = {
  title: "Shares — m1n3 Protocol",
  description: "Mining shares accepted and recorded on-chain by the m1n3 pool",
};

export default function SharesPage() {
  return (
    <>
      <Navigation />
      <main className="min-h-screen bg-background">
        <div className="mx-auto max-w-screen-2xl px-4 pt-8 pb-20">
          <div className="mb-6">
            <h1 className="font-mono text-lg font-semibold tracking-tight text-foreground">
              Shares
            </h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              Mining shares recorded on-chain via{" "}
              <code className="rounded bg-muted px-1 py-0.5">pool::submit_share</code>
              {" "}· each row is a PoW share the bridge verified and committed to Sui
            </p>
          </div>
          <SharesTable />
        </div>
      </main>
    </>
  );
}
