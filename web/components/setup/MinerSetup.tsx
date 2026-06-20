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
  Wallet,
  Cpu,
  Wifi,
  Coins,
} from "lucide-react";

export function MinerSetup() {
  return (
    <div className="space-y-6">
      {/* Requirements */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Requirements</CardTitle>
          <CardDescription>What you need to start mining</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <RequirementCard
              icon={<Wallet className="h-4 w-4" />}
              name="Sui Wallet"
              description="A Sui address to receive mining shares and submit transactions"
              required
              link="https://docs.sui.io/guides/developer/getting-started/sui-environment"
            />
            <RequirementCard
              icon={<Cpu className="h-4 w-4" />}
              name="Mining Hardware"
              description="Any SHA-256 mining hardware (ASIC recommended for mainnet)"
              required
            />
            <RequirementCard
              icon={<Wifi className="h-4 w-4" />}
              name="Internet Connection"
              description="Stable connection to reach the stratum server"
              required
            />
            <RequirementCard
              icon={<Coins className="h-4 w-4" />}
              name="SUI for Gas"
              description="Small amount of SUI tokens to pay for on-chain transactions"
              required
            />
          </div>
        </CardContent>
      </Card>

      {/* Sui Wallet Setup */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sui Wallet Setup</CardTitle>
          <CardDescription>
            Create and fund a Sui address
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <StepCard step={1} title="Install Sui CLI">
            <CodeBlock
              code={`cargo install --locked --git https://github.com/MystenLabs/sui.git --branch devnet sui`}
              language="bash"
            />
          </StepCard>
          <StepCard step={2} title="Create a new address">
            <CodeBlock
              code={`sui client new-address ed25519

# Save the recovery phrase securely!`}
              language="bash"
            />
          </StepCard>
          <StepCard step={3} title="Fund your wallet">
            <p>
              Get your active address and request SUI from the faucet (devnet):
            </p>
            <CodeBlock code={`sui client active-address
sui client faucet`} language="bash" />
          </StepCard>
        </CardContent>
      </Card>

      {/* Option A: Connect to Pool */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Option A: Connect to an Existing Pool
          </CardTitle>
          <CardDescription>
            The fastest way to start mining
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>
            Point your mining hardware at a running m1n3 stratum server using the
            standard stratum protocol:
          </p>
          <CodeBlock
            code={`stratum+tcp://<pool-server>:3333
Username: <sui_address>.<worker_name>   (e.g. 0xe855cb8f...1780e.rig1)
Password: x`}
            filename="Stratum Connection"
          />
          <div className="rounded-md border p-3 bg-muted/50">
            <p className="text-muted-foreground">
              <strong>Username format:</strong> Your Sui hex address followed by a
              dot and a worker name of your choice. The worker name helps you
              identify different rigs in pool statistics.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Option B: Trustless Mode */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Option B: Trustless Mode (miner-sidecar)
          </CardTitle>
          <CardDescription>
            Submit shares directly with your own keypair
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>
            The sidecar runs alongside your mining hardware as a local Stratum
            proxy. Accepted shares are submitted to Sui with <strong>your</strong> keypair
            — the pool operator is never in the attribution path.
          </p>
          <CodeBlock
            code={`./target/release/miner-sidecar \\
  --stratum-host <pool-server>:3333 \\
  --listen-port 3334 \\
  --sui-keystore ~/.sui/sui_config/sui.keystore \\
  --sui-package <PACKAGE_ID> \\
  --pool-object <POOL_OBJECT_ID>

# Point your mining hardware to localhost:3334`}
            language="bash"
          />
        </CardContent>
      </Card>

      {/* Miner Registration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Miner Registration</CardTitle>
          <CardDescription>
            Register your miner on-chain
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>
            Your <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">MinerStats</code> object
            is created automatically on your first share submission. This is an owned Sui object
            that tracks your lifetime work and payout address.
          </p>
          <div className="rounded-md border p-3 bg-muted/50">
            <p className="text-muted-foreground">
              <strong>Note:</strong> Registration happens automatically — no manual step required.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
