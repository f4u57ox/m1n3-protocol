import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CodeBlock } from "./CodeBlock";
import { StepCard } from "./StepCard";
import { RequirementCard } from "./RequirementCard";
import {
  Box,
  Wrench,
  Globe,
  Terminal,
  Wallet,
} from "lucide-react";

export function PoolOperatorSetup() {
  return (
    <div className="space-y-6">
      {/* Full Stack Requirements */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Full Stack Requirements</CardTitle>
          <CardDescription>
            Everything needed to run a complete m1n3 pool
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <RequirementCard
              icon={<Box className="h-4 w-4" />}
              name="Bitcoin Core"
              description="Full node with RPC enabled (v25+ recommended)"
              required
              link="https://bitcoincore.org/en/download/"
            />
            <RequirementCard
              icon={<Wrench className="h-4 w-4" />}
              name="Rust Toolchain"
              description="Rust 1.75+ for all Rust binaries"
              required
              link="https://rustup.rs/"
            />
            <RequirementCard
              icon={<Globe className="h-4 w-4" />}
              name="Node.js 20+"
              description="For the IKA service and dashboard"
              required
              link="https://nodejs.org/"
            />
            <RequirementCard
              icon={<Terminal className="h-4 w-4" />}
              name="Sui CLI"
              description="For contract deployment and keypair management"
              required
              link="https://docs.sui.io/guides/developer/getting-started/sui-environment"
            />
            <RequirementCard
              icon={<Wallet className="h-4 w-4" />}
              name="Funded Sui Wallet"
              description="SUI tokens for gas on all on-chain operations"
              required
            />
          </div>
        </CardContent>
      </Card>

      {/* Deploy Contracts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">1. Deploy the Contracts</CardTitle>
          <CardDescription>
            Publish the Sui Move package
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <CodeBlock
            code={`cd contracts
sui client publish --gas-budget 200000000`}
            language="bash"
          />
          <p className="text-muted-foreground">
            Note the package ID and all shared object IDs printed after deployment.
          </p>
        </CardContent>
      </Card>

      {/* Stratum Server */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">2. Stratum Server</CardTitle>
          <CardDescription>
            Mining protocol bridge to Sui
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <CodeBlock
            code={`BITCOIN_RPC_URL=http://user:pass@127.0.0.1:8332 \\
./target/release/stratum-server \\
  --sui-package <PACKAGE_ID> \\
  --pool-object <POOL_OBJECT_ID> \\
  --pool-admin-cap <ADMIN_CAP_ID> \\
  --pool-address <HEX_SCRIPTPUBKEY> \\
  --sui-rpc-url https://fullnode.devnet.sui.io:443 \\
  --sui-keystore ~/.sui/sui_config/sui.keystore \\
  --port 3333 \\
  --metrics-port 9091 \\
  --initial-difficulty 10000 \\
  --target-shares-per-min 10`}
            language="bash"
          />
          <div className="rounded-md border p-3 bg-muted/50">
            <p className="text-muted-foreground">
              <strong>Tip:</strong> Adjust{" "}
              <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">--initial-difficulty</code>{" "}
              and{" "}
              <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">--target-shares-per-min</code>{" "}
              based on your pool&apos;s total hashrate.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Operator Bot */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">3. Operator Bot</CardTitle>
          <CardDescription>
            Autonomous reward pipeline
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <CodeBlock
            code={`BITCOIN_RPC_URL=http://user:pass@127.0.0.1:8332 \\
./target/release/operator-bot \\
  --sui-package <PACKAGE_ID> \\
  --pool-object <POOL_OBJECT_ID> \\
  --pool-admin-cap <ADMIN_CAP_ID> \\
  --sui-rpc-url https://fullnode.devnet.sui.io:443 \\
  --sui-keystore ~/.sui/sui_config/sui.keystore`}
            language="bash"
          />
        </CardContent>
      </Card>

      {/* IKA Service */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">4. IKA Service (optional)</CardTitle>
          <CardDescription>
            dWallet-based Bitcoin signing for the Ika reward path
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <StepCard step={1} title="Install dependencies">
            <CodeBlock
              code={`cd ika-service
npm install`}
              language="bash"
            />
          </StepCard>
          <StepCard step={2} title="Configure environment">
            <CodeBlock
              code={`IKA_NETWORK=mainnet
IKA_HTTP_PORT=3000
IKA_SOCKET_PATH=/tmp/m1n3-ika.sock`}
              filename=".env"
            />
          </StepCard>
          <StepCard step={3} title="Run the service">
            <CodeBlock code="npm start" language="bash" />
          </StepCard>
        </CardContent>
      </Card>

      {/* Dashboard Deployment */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">5. Dashboard Deployment</CardTitle>
          <CardDescription>
            Deploy the web dashboard for your pool
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <StepCard step={1} title="Install and configure">
            <CodeBlock
              code={`cd dashboard
npm install`}
              language="bash"
            />
            <p>
              Create a{" "}
              <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">.env.local</code>{" "}
              with your package and pool object IDs (see Reference tab).
            </p>
          </StepCard>
          <StepCard step={2} title="Build for production">
            <CodeBlock code="npm run build" language="bash" />
          </StepCard>
          <StepCard step={3} title="Deploy">
            <p>
              Deploy the{" "}
              <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">out/</code>{" "}
              directory to any static host (Vercel, Netlify, Cloudflare Pages, etc.)
            </p>
          </StepCard>
        </CardContent>
      </Card>
    </div>
  );
}
