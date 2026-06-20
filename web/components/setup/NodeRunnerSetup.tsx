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
  HardDrive,
  Box,
} from "lucide-react";

export function NodeRunnerSetup() {
  return (
    <div className="space-y-6">
      {/* Requirements */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Requirements</CardTitle>
          <CardDescription>
            What you need to run a Bitcoin full node for m1n3
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
              icon={<HardDrive className="h-4 w-4" />}
              name="Disk Space"
              description="~600 GB for the Bitcoin blockchain"
              required
            />
          </div>
        </CardContent>
      </Card>

      {/* Bitcoin Core Setup */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Bitcoin Core Setup</CardTitle>
          <CardDescription>
            Install and configure your full node
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <StepCard step={1} title="Install Bitcoin Core">
            <CodeBlock
              code={`# macOS
brew install bitcoin

# Ubuntu/Debian
sudo apt install bitcoind`}
              language="bash"
            />
          </StepCard>
          <StepCard step={2} title="Configure bitcoin.conf">
            <p>
              Enable RPC access so the stratum server can call{" "}
              <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">getblocktemplate</code>:
            </p>
            <CodeBlock
              code={`# ~/.bitcoin/bitcoin.conf
server=1
rpcuser=your_rpc_user
rpcpassword=your_rpc_password
rpcallowip=127.0.0.1
rpcport=8332
txindex=1`}
              filename="bitcoin.conf"
            />
          </StepCard>
          <StepCard step={3} title="Start and sync">
            <CodeBlock code="bitcoind -daemon" language="bash" />
            <p>
              Initial sync may take several days. Monitor progress with:
            </p>
            <CodeBlock code="bitcoin-cli getblockchaininfo" language="bash" />
          </StepCard>
          <StepCard step={4} title="Verify RPC is working">
            <CodeBlock
              code="bitcoin-cli getblockcount"
              language="bash"
            />
            <p>
              This should return the current block height. If it errors,
              check your bitcoin.conf settings.
            </p>
          </StepCard>
        </CardContent>
      </Card>

      {/* Usage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Usage with m1n3</CardTitle>
          <CardDescription>
            How Bitcoin Core connects to the stratum server
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Point the stratum server at your local node using{" "}
            <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
              BITCOIN_RPC_URL=http://user:pass@127.0.0.1:8332
            </code>.
          </p>
          <p className="text-muted-foreground">
            The stratum server polls <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">getblocktemplate</code> and
            pushes new work to miners via <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">mining.notify</code>.
            New Bitcoin blocks are detected via long polling, triggering an immediate template refresh.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
