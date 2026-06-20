"use client";

import React, { useEffect, useState } from "react";
import { suiClient } from "@/lib/sui-client";
import { Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

export const ConnectionIndicator = React.memo(function ConnectionIndicator() {
  const [rpcConnected, setRpcConnected] = useState(false);

  useEffect(() => {
    const checkConnection = async () => {
      try {
        await suiClient.getChainIdentifier();
        setRpcConnected(true);
      } catch {
        setRpcConnected(false);
      }
    };

    checkConnection();
    const interval = setInterval(checkConnection, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium",
        rpcConnected
          ? "bg-green-500/10 text-green-600 dark:text-green-400"
          : "bg-red-500/10 text-red-600 dark:text-red-400"
      )}
    >
      {rpcConnected ? (
        <Wifi className="h-3 w-3" />
      ) : (
        <WifiOff className="h-3 w-3" />
      )}
      <span>{rpcConnected ? "Connected" : "Disconnected"}</span>
    </div>
  );
});
