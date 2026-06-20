import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CodeBlock } from "./CodeBlock";

const MAINNET_ACCOUNTS = [
  {
    name: "Package ID",
    id: "See contracts/Published.toml",
  },
  {
    name: "Pool Object",
    id: "(shared object — printed on deployment)",
  },
];

const NETWORKS = [
  { name: "Mainnet", rpc: "https://fullnode.mainnet.sui.io:443" },
  { name: "Testnet", rpc: "https://fullnode.testnet.sui.io:443" },
  { name: "Devnet", rpc: "https://fullnode.devnet.sui.io:443" },
];

const ENV_TEMPLATE = `# Sui Network
NEXT_PUBLIC_SUI_NETWORK=devnet
NEXT_PUBLIC_SUI_RPC_URL=https://fullnode.devnet.sui.io:443

# m1n3 package and shared objects (from Published.toml)
NEXT_PUBLIC_PACKAGE_ID=<PACKAGE_ID>
NEXT_PUBLIC_POOL_OBJECT_ID=<POOL_OBJECT_ID>`;

const FEE_ESTIMATES = [
  { operation: "Miner Registration", cost: "~0.001 SUI" },
  { operation: "Share Submission", cost: "~0.001 SUI" },
  { operation: "Template Registration", cost: "~0.001 SUI" },
  { operation: "Round Close", cost: "~0.002 SUI" },
];

export function ReferenceSection() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Reference</h2>
        <p className="text-sm text-muted-foreground">
          Configuration values, program IDs, and network details
        </p>
      </div>

      {/* Mainnet Accounts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Mainnet Program Addresses</CardTitle>
          <CardDescription>
            On-chain addresses for the m1n3 Sui package
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {MAINNET_ACCOUNTS.map((obj) => (
              <div
                key={obj.name}
                className="flex flex-col gap-1 rounded-md border p-2 sm:flex-row sm:items-center sm:gap-3"
              >
                <span className="text-sm font-medium w-40 shrink-0">
                  {obj.name}
                </span>
                <code className="font-mono text-xs text-muted-foreground break-all">
                  {obj.id}
                </code>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Supported Networks */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Supported Networks</CardTitle>
          <CardDescription>Sui RPC endpoints</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {NETWORKS.map((net) => (
              <div
                key={net.name}
                className="flex items-center gap-3 rounded-md border p-2"
              >
                <span className="text-sm font-medium w-24">{net.name}</span>
                <code className="font-mono text-xs text-muted-foreground">
                  {net.rpc}
                </code>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Environment Variables */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Environment Variables</CardTitle>
          <CardDescription>
            Full .env.local template for the dashboard
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={ENV_TEMPLATE} filename=".env.local" />
        </CardContent>
      </Card>

      {/* Transaction Fee Estimates */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Transaction Fee Estimates</CardTitle>
          <CardDescription>
            Approximate SUI gas per operation
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {FEE_ESTIMATES.map((item) => (
              <div
                key={item.operation}
                className="flex items-center justify-between rounded-md border p-2"
              >
                <span className="text-sm">{item.operation}</span>
                <code className="font-mono text-xs text-muted-foreground">
                  {item.cost}
                </code>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
