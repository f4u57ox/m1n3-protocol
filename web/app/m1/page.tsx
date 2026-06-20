"use client";

import { Suspense } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useTabParam } from "@/hooks/useTabParam";
import { PoolOverviewTab } from "@/components/pool/PoolOverviewTab";
import { MinersTab } from "@/components/pool/MinersTab";
import { TimingTab } from "@/components/pool/TimingTab";

function M1PageContent() {
  const { tab, setTab } = useTabParam("overview");

  return (
    <>
      <title>m1n3 — Pool</title>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Pool</h1>
          <p className="text-muted-foreground">
            Live mining pool dashboard — track hashrate, active miners, shares, and block templates in real time
          </p>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">overview</TabsTrigger>
            <TabsTrigger value="miners">miners</TabsTrigger>
            <TabsTrigger value="timing">timing</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <PoolOverviewTab />
          </TabsContent>

          <TabsContent value="miners">
            <MinersTab />
          </TabsContent>

          <TabsContent value="timing">
            <TimingTab />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

export default function M1Page() {
  return (
    <Suspense>
      <M1PageContent />
    </Suspense>
  );
}
