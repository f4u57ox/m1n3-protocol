"use client";

function Avatar({ name, emoji, color }: { name: string; emoji: string; color: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className={`w-10 h-10 rounded-full border-2 flex items-center justify-center text-xl ${color}`}
      >
        {emoji}
      </div>
      <span className={`font-bold text-sm tracking-wide ${color}`}>{name}</span>
    </div>
  );
}

function StepCard({
  number,
  title,
  description,
  icon,
  highlight,
}: {
  number: string;
  title: string;
  description: string;
  icon?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex gap-3 p-3 rounded-lg border ${
        highlight
          ? "bg-amber-500/10 border-amber-500/20"
          : "bg-muted/50 border-border"
      }`}
    >
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold shrink-0 mt-0.5 ${
          highlight
            ? "bg-amber-500/20 text-amber-500"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {icon || number}
      </div>
      <div>
        <div className="font-bold text-xs mb-0.5 text-foreground">{title}</div>
        <div className="text-[11.5px] leading-relaxed text-muted-foreground">{description}</div>
      </div>
    </div>
  );
}

function TimelineArrow({ label, lineColor, textColor }: { label: string; lineColor: string; textColor: string }) {
  return (
    <div className="flex items-center gap-1.5 pl-3">
      <div className={`w-0.5 h-4 ${lineColor}`} />
      <span className={`text-[11px] ${textColor}`}>{label}</span>
    </div>
  );
}

function MCBadge({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <span
      className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider border ${className}`}
    >
      {children}
    </span>
  );
}

function ColumnHeader({ label, className }: { label: string; className: string }) {
  return (
    <div className={`text-[10px] tracking-[0.18em] font-bold mb-3 text-center ${className}`}>
      {label}
    </div>
  );
}

function TraditionalColumn() {
  return (
    <div className="flex flex-col gap-2.5">
      <ColumnHeader label="TRADITIONAL POOL" className="text-amber-500 dark:text-amber-400" />

      <div className="rounded-xl border bg-card p-4">
        <div className="flex justify-between items-center mb-3.5">
          <Avatar name="Alice" emoji="⛏" color="text-amber-500 dark:text-amber-400 border-amber-500/40 bg-amber-500/10" />
          <MCBadge className="bg-red-500/10 text-red-500 dark:text-red-400 border-red-500/20">TRADITIONAL MINER</MCBadge>
        </div>

        <div className="flex flex-col gap-1.5">
          <StepCard
            number="1"
            title="Alice submits hashrate to pool"
            description="Her ASICs grind hashes 24/7 and submit shares to the pool's stratum server."
          />
          <TimelineArrow label="shares go into a black box" lineColor="bg-muted-foreground/40" textColor="text-foreground/60 dark:text-foreground/70" />
          <StepCard
            number="2"
            title="Pool records shares internally"
            description="The operator tracks Alice's work in their private database. She can't independently verify her share count."
          />
          <TimelineArrow label="trust required" lineColor="bg-red-400/60" textColor="text-red-600 dark:text-red-400" />
          <StepCard
            number="3"
            title="Alice waits for payout"
            description="Hours or days pass. Her capital is locked — she can't do anything with her earned-but-unpaid work."
          />
          <TimelineArrow label="hours to days..." lineColor="bg-red-400" textColor="text-red-600 dark:text-red-400" />
          <StepCard
            number="4"
            title="Pool holds Alice's BTC (custodial)"
            description="The pool operator has full custody of Alice's earned BTC. She has to trust they'll actually pay out — and that they won't disappear with the funds."
          />
          <TimelineArrow label="BTC drops while she waits" lineColor="bg-red-400" textColor="text-red-600 dark:text-red-400" />
          <StepCard
            number="5"
            title="Alice's payout loses value"
            description="By the time Alice receives her BTC, the price has dropped. Her mining revenue is worth less than when she earned it — and she had no way to lock in the earlier price."
          />
        </div>
      </div>

      <div className="rounded-lg border border-red-500/15 bg-red-500/5 px-4 py-3 text-xs font-semibold text-center text-red-500 dark:text-red-400 leading-relaxed">
        Custodial. No transparency. No liquidity. Full price risk.
      </div>
    </div>
  );
}

function M1n3Column() {
  return (
    <div className="flex flex-col gap-2.5">
      <ColumnHeader label="M1N3 PROTOCOL" className="text-blue-500 dark:text-blue-400" />

      <div className="rounded-xl border border-blue-500/20 bg-card p-4">
        <div className="flex justify-between items-center mb-3.5">
          <Avatar name="Bob" emoji="⛏" color="text-blue-500 dark:text-blue-400 border-blue-500/40 bg-blue-500/10" />
          <MCBadge className="bg-blue-500/10 text-blue-500 dark:text-blue-400 border-blue-500/20">M1N3 MINER</MCBadge>
        </div>

        <div className="flex flex-col gap-1.5">
          <StepCard
            number="1"
            title="Bob submits hashrate to the network"
            description="Same ASICs, same work — but shares are submitted to the m1n3 decentralized pool coordinator."
          />
          <TimelineArrow label="cryptographic proof" lineColor="bg-blue-400" textColor="text-blue-600 dark:text-blue-400" />
          <StepCard
            number="2"
            title="Shares verified & registered on Sui"
            description="Each valid share is recorded on-chain in the share registry. Bob can prove exactly how much work he's done — no trust needed."
            highlight
            icon="✓"
          />
          <TimelineArrow label="instant!" lineColor="bg-emerald-400" textColor="text-emerald-600 dark:text-emerald-400" />
          <StepCard
            number="3"
            title="Bob has options"
            description="His shares are verified on-chain assets. He can wait for the BTC payout, or sell his shares right now on the marketplace."
            highlight
            icon="⚡"
          />
          <TimelineArrow label="enforced on-chain" lineColor="bg-emerald-400" textColor="text-emerald-600 dark:text-emerald-400" />
          <StepCard
            number="4"
            title="Rewards distributed via dWallets"
            description="BTC reward distributions are enforced on-chain through dWallets — no operator can withhold or redirect funds. Fully non-custodial."
            highlight
            icon="🔐"
          />
          <TimelineArrow label="BTC drops, but..." lineColor="bg-emerald-400" textColor="text-emerald-600 dark:text-emerald-400" />
          <StepCard
            number="5"
            title="Bob already locked in his price"
            description="Bob sold his shares at a ~5% discount hours ago. Even though BTC dropped, his revenue is already secured. He doesn't rely on Bitcoin's price for his mining operations."
            highlight
            icon="🛡"
          />
        </div>
      </div>

      {/* Trade box */}
      <div className="rounded-xl border border-blue-500/20 bg-gradient-to-br from-blue-500/5 to-emerald-500/5 p-4">
        <div className="text-[10px] tracking-[0.15em] text-emerald-500 dark:text-emerald-400 font-bold mb-2.5">
          INSTANT LIQUIDITY
        </div>
        <div className="text-xs leading-relaxed text-muted-foreground">
          <strong className="text-foreground">Example:</strong> Bob has 1,000 verified shares worth ~0.005 BTC.
          A buyer offers 0.0047 BTC right now — a small discount for{" "}
          <span className="text-emerald-500 dark:text-emerald-400 font-bold">instant liquidity</span>. Bob gets paid
          immediately. The buyer earns the spread when the block reward distributes.
        </div>
      </div>

      <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 px-4 py-3 text-xs font-semibold text-center text-emerald-500 dark:text-emerald-400 leading-relaxed">
        Non-custodial · Verified · Liquid · Instant
      </div>
    </div>
  );
}

export function MiningComparison() {
  return (
    <div className="font-mono py-8">
      {/* Header */}
      <div className="text-center mb-7">
        <div className="text-[11px] tracking-[0.2em] text-amber-500 dark:text-amber-400 font-bold mb-2">
          MINING POOL COMPARISON
        </div>
        <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight font-sans leading-tight">
          Two Miners, Two Paths
        </h2>
        <p className="text-muted-foreground text-sm mt-2 max-w-[500px] mx-auto">
          Alice mines on a traditional pool. Bob mines on m1n3.
          <br />
          Same hardware, same work — different outcomes.
        </p>
      </div>

      {/* Side-by-side columns */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
        <TraditionalColumn />
        <M1n3Column />
      </div>

      {/* Bottom comparison table */}
      <div>
        <div className="text-[11px] tracking-[0.15em] text-muted-foreground font-bold mb-3">
          SIDE BY SIDE
        </div>
        <div className="rounded-xl overflow-hidden border">
          {[
            { label: "Share Verification", old: "Trust the pool operator", neo: "Verified on-chain (Sui)" },
            { label: "Payout Speed", old: "Hours to days", neo: "Instant (sell shares now)" },
            { label: "Liquidity", old: "Locked until payout", neo: "Trade shares anytime" },
            { label: "Transparency", old: "Pool's internal database", neo: "Public on-chain registry" },
            { label: "Custody", old: "Custodial — pool can run with your BTC", neo: "Non-custodial — dWallet-enforced payouts" },
            { label: "Price Risk", old: "Exposed to BTC drops during payout delay", neo: "Sell shares now, lock in value regardless" },
          ].map((row, i) => (
            <div
              key={row.label}
              className={`grid grid-cols-3 text-xs ${i < 5 ? "border-b" : ""}`}
            >
              <div className="px-3.5 py-2.5 font-bold text-foreground bg-card">
                {row.label}
              </div>
              <div className="px-3.5 py-2.5 text-red-500/80 dark:text-red-400/80 bg-card border-l">
                {row.old}
              </div>
              <div className="px-3.5 py-2.5 text-emerald-600 dark:text-emerald-400 bg-blue-500/5 border-l">
                {row.neo}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
