"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { MinerSetup } from "./MinerSetup";
import { NodeRunnerSetup } from "./NodeRunnerSetup";
import { PoolOperatorSetup } from "./PoolOperatorSetup";

export function SetupTabs() {
  return (
    <Tabs defaultValue="miner">
      <TabsList>
        <TabsTrigger value="miner">Miner</TabsTrigger>
        <TabsTrigger value="node-runner">Node Runner</TabsTrigger>
        <TabsTrigger value="pool-operator">Pool Operator</TabsTrigger>
      </TabsList>
      <TabsContent value="miner">
        <MinerSetup />
      </TabsContent>
      <TabsContent value="node-runner">
        <NodeRunnerSetup />
      </TabsContent>
      <TabsContent value="pool-operator">
        <PoolOperatorSetup />
      </TabsContent>
    </Tabs>
  );
}
