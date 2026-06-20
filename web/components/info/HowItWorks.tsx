import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function HowItWorks() {
  return (
    <div className="space-y-6">
      {/* Project Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Project Overview</CardTitle>
          <CardDescription>What is m1n3?</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            <strong>m1n3</strong> is a decentralized bitcoin mining protocol
            built on chain with four distinct roles:
          </p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>
              <strong>Node Running</strong> &mdash; run a Bitcoin full node and
              register blocks on-chain to mint m1n3 tokens (the only minting
              path)
            </li>
            <li>
              <strong>Token</strong> &mdash; m1n3 is the native incentive token,
              used for staking on block templates
            </li>
            <li>
              <strong>Mining &amp; Templates</strong> &mdash; miners build their
              own block templates or use on-chain templates, perform SHA-256 PoW,
              and submit shares to Sui for trustless verification
            </li>
            <li>
              <strong>Share Trading</strong> &mdash; mining shares are tradeable
              on-chain assets, redeemable for BTC rewards
            </li>
          </ul>
          <p>
            No pool operator controls your templates, tokens, or bitcoin.
            Miners who hold and redeem their shares pay zero fees.
          </p>
        </CardContent>
      </Card>

      {/* Node Runners */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Node Runners</CardTitle>
          <CardDescription>
            Securing Bitcoin&apos;s decentralization
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Bitcoin full nodes are critical to the network&apos;s
            decentralization, yet they have no built-in financial incentive.
            m1n3 solves this: node runners register blocks on-chain and earn
            m1n3 tokens &mdash; the <strong>only</strong> way tokens are minted.
          </p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Run a Bitcoin full node</li>
            <li>Register blocks on-chain via Sui</li>
            <li>Earn m1n3 tokens for each registered block</li>
            <li>Strengthen Bitcoin&apos;s decentralization</li>
          </ul>
        </CardContent>
      </Card>

      {/* m1n3 Token */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">m1n3 Token</CardTitle>
          <CardDescription>The native incentive token</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            The <strong>m1n3</strong> token is the native incentive token of the
            ecosystem. It is minted exclusively through node running &mdash;
            when node runners register blocks on-chain.
          </p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>
              <strong>Minting:</strong> Only through block registration by node
              runners &mdash; no pre-mine, no other minting path
            </li>
            <li>
              <strong>Utility:</strong> Stake on block templates to signal
              confidence and earn a share of the 2% share-trading tax
            </li>
            <li>
              <strong>Tradeable:</strong> Instantly liquid on-chain &mdash; no
              waiting for a Bitcoin block to be found
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Block Templates & Mining */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Block Templates &amp; Mining</CardTitle>
          <CardDescription>Step-by-step process</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-2">
            <p className="font-medium">1. Template Creation</p>
            <p className="text-muted-foreground pl-4">
              Miners build their own block template from their local Bitcoin
              full node &mdash; choosing which transactions to include &mdash;
              or fetch a template already registered on-chain by another node
              runner.
            </p>
          </div>
          <div className="space-y-2">
            <p className="font-medium">2. On-Chain Template Visibility</p>
            <p className="text-muted-foreground pl-4">
              Each template registered on Sui is publicly visible and shows:
              total work dedicated, number of unique miners, and total m1n3
              staked &mdash; giving miners full transparency before they choose
              where to direct hashpower.
            </p>
          </div>
          <div className="space-y-2">
            <p className="font-medium">3. Mining &amp; Share Submission</p>
            <p className="text-muted-foreground pl-4">
              Miners perform SHA-256 double-hash Proof of Work against their
              chosen template. When a valid share meeting the pool difficulty
              target is found, it is submitted as a transaction to Sui.
            </p>
          </div>
          <div className="space-y-2">
            <p className="font-medium">4. On-Chain Verification</p>
            <p className="text-muted-foreground pl-4">
              The Sui Move contract verifies the SHA-256 double-hash and
              validates that the share meets the required difficulty target. No
              off-chain trust is required &mdash; verification is fully
              trustless.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Mining Shares & Futures Market */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Mining Shares</CardTitle>
          <CardDescription>Tradeable on-chain assets</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Mining shares in m1n3 are not just Proof of Work receipts &mdash;
            they are fully tradeable on-chain assets that unlock a futures
            market for hashrate.
          </p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>
              <strong>Tradeable:</strong> Buy and sell shares on the open market
            </li>
            <li>
              <strong>Redeemable:</strong> Redeem shares for BTC rewards when
              blocks are found
            </li>
            <li>
              <strong>Speculation &amp; Hedging:</strong> Enables a futures
              market &mdash; speculate on hashrate or hedge mining output
            </li>
            <li>
              <strong>2% Transfer Tax:</strong> A 2% tax on share trades is
              distributed to all m1n3 stakers
            </li>
            <li>
              <strong>Zero Cost for Holders:</strong> Miners who hold and redeem
              their own shares pay nothing
            </li>
          </ul>
          <div className="mt-3 rounded-md border p-3 bg-muted/50">
            <p className="text-muted-foreground">
              <strong>Comparison:</strong> Most mining pools charge 2% on{" "}
              <em>all</em> rewards. m1n3 charges <strong>0%</strong> pool fees.
              The 2% tax only applies when shares are traded, and it goes
              directly to m1n3 stakers &mdash; not to a pool operator.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Why m1n3 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Why m1n3</CardTitle>
          <CardDescription>Key differentiators</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-2">
            <p className="font-medium">Dynamic Hashrate Tokenization</p>
            <p className="text-muted-foreground pl-4">
              Legacy hashrate tokenization projects use fixed-rate tokens that
              get diluted as global hashpower increases. m1n3 shares represent
              actual work performed at actual network difficulty &mdash; a
              direct, undiluted claim on mining output.
            </p>
          </div>
          <div className="space-y-2">
            <p className="font-medium">Exchange-Grade Liquidity</p>
            <p className="text-muted-foreground pl-4">
              Miners traditionally lack an immediate exit for their hashrate.
              m1n3 creates a secondary market: sell shares for immediate cash,
              or trade and hedge your mining output &mdash; all on-chain with
              instant settlement.
            </p>
          </div>
          <div className="space-y-2">
            <p className="font-medium">Zero Pool Fees</p>
            <p className="text-muted-foreground pl-4">
              0% pool fee vs the industry standard 2%. The only fee in the
              ecosystem is a 2% tax on share trading, distributed entirely to
              m1n3 stakers. Mine and redeem = keep everything.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Staking Mechanism */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Staking Mechanism</CardTitle>
          <CardDescription>
            Stake m1n3 tokens on block templates
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Staking m1n3 tokens on a block template serves two purposes: it
            signals confidence in that template (visible on-chain to miners
            choosing where to direct hashpower) and earns stakers a share of
            the 2% share-trading tax.
          </p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Stake m1n3 tokens on any active template</li>
            <li>
              Earn a proportional share of the 2% tax on share trades
            </li>
            <li>Unstake anytime with a cooldown period</li>
            <li>Higher stake = larger share of tax revenue</li>
            <li>
              Bitcoin reward distributions are handled via MPC technology and
              enforced in the smart contract
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Block Header Structure */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Block Header Structure</CardTitle>
          <CardDescription>The 80-byte Bitcoin block header</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Every Bitcoin block header is exactly 80 bytes, divided into six
            fields. Miners hash this header repeatedly with different nonce
            values to find a valid Proof of Work.
          </p>
          <div className="grid gap-2 font-mono text-xs">
            <div className="flex items-center gap-3">
              <span
                className="w-3 h-3 rounded"
                style={{ backgroundColor: "#4f6d7a" }}
              />
              <span className="w-24">Version</span>
              <span className="text-muted-foreground">
                Bytes 0-3 (4 bytes)
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="w-3 h-3 rounded"
                style={{ backgroundColor: "#3b5998" }}
              />
              <span className="w-24">PrevHash</span>
              <span className="text-muted-foreground">
                Bytes 4-35 (32 bytes)
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="w-3 h-3 rounded"
                style={{ backgroundColor: "#5b4a8c" }}
              />
              <span className="w-24">MerkleRoot</span>
              <span className="text-muted-foreground">
                Bytes 36-67 (32 bytes)
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="w-3 h-3 rounded"
                style={{ backgroundColor: "#6b5b3e" }}
              />
              <span className="w-24">nTime</span>
              <span className="text-muted-foreground">
                Bytes 68-71 (4 bytes)
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="w-3 h-3 rounded"
                style={{ backgroundColor: "#3b6e5e" }}
              />
              <span className="w-24">nBits</span>
              <span className="text-muted-foreground">
                Bytes 72-75 (4 bytes)
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="w-3 h-3 rounded"
                style={{ backgroundColor: "#7a4a4f" }}
              />
              <span className="w-24">Nonce</span>
              <span className="text-muted-foreground">
                Bytes 76-79 (4 bytes)
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Architecture */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Architecture</CardTitle>
          <CardDescription>System components</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-3">
            <div>
              <p className="font-medium">Sui Move Contracts</p>
              <p className="text-muted-foreground pl-4">
                Core protocol logic &mdash; template registration, share
                verification (SHA-256 double-hash), token minting, and
                reward distribution.
              </p>
            </div>
            <div>
              <p className="font-medium">Stratum Server</p>
              <p className="text-muted-foreground pl-4">
                Rust service that speaks the Stratum mining protocol to
                connect miners, manages difficulty adjustment, and bridges
                valid shares to the Sui blockchain.
              </p>
            </div>
            <div>
              <p className="font-medium">Gateway</p>
              <p className="text-muted-foreground pl-4">
                Interfaces with the miner&apos;s Bitcoin full node to
                construct block templates and relay work to connected miners
                via Stratum.
              </p>
            </div>
            <div>
              <p className="font-medium">MPC Bitcoin Distribution</p>
              <p className="text-muted-foreground pl-4">
                Non-custodial Bitcoin signing via MPC technology. Enables
                trustless Bitcoin reward distribution to share holders,
                enforced by the smart contract.
              </p>
            </div>
            <div>
              <p className="font-medium">Dashboard</p>
              <p className="text-muted-foreground pl-4">
                Web interface for exploring pool activity, templates, miners,
                rewards, and interacting with staking functionality.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
