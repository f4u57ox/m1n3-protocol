"use client";

import type { StepKey } from "@/data/steps";

/**
 * Sticky-pane illustrations. Each diagram is small (no canvas) — relies on
 * `flow-dash` / `pulse-dot` / `spin-slow` keyframes from globals.css.
 */
export function StepDiagram({ id }: { id: StepKey }) {
  switch (id) {
    case "template":
      return <DiagTemplate />;
    case "submit":
      return <DiagSubmit />;
    case "validate":
      return <DiagValidate />;
    case "block-found":
      return <DiagBlockFound />;
    case "accumulator":
      return <DiagAccumulator />;
    case "finalize":
      return <DiagFinalize />;
    case "hashi-deposit":
      return <DiagHashiDeposit />;
    case "hashi-confirm":
      return <DiagHashiConfirm />;
    case "fund-batch":
      return <DiagFundBatch />;
    case "hashshare-mint":
      return <DiagMint />;
    case "deepbook":
      return <DiagDeepBook />;
    case "claim":
      return <DiagClaim />;
  }
}

/* ── shared primitives ──────────────────────────────────────────────────── */

function Frame({
  caption,
  children,
}: {
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0 grid place-items-center">
        <div className="aspect-square w-full max-w-[460px]">
          <svg viewBox="0 0 400 400" className="h-full w-full">
            {children}
          </svg>
        </div>
      </div>
      <p className="absolute bottom-3 left-0 right-0 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        {caption}
      </p>
    </div>
  );
}

function Box({
  x, y, w, h, label, sub, color = "hsl(var(--foreground))", dim = false,
}: {
  x: number; y: number; w: number; h: number;
  label: string; sub?: string; color?: string; dim?: boolean;
}) {
  return (
    <g opacity={dim ? 0.55 : 1}>
      <rect
        x={x} y={y} width={w} height={h} rx={10}
        fill="hsl(var(--background))"
        stroke={color}
        strokeOpacity={0.7}
        strokeWidth={1.2}
      />
      <text
        x={x + w / 2}
        y={y + h / 2 - (sub ? 6 : 0)}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="12"
        fontWeight={600}
        fill="hsl(var(--foreground))"
      >
        {label}
      </text>
      {sub && (
        <text
          x={x + w / 2}
          y={y + h / 2 + 12}
          textAnchor="middle"
          fontSize="9"
          className="font-mono"
          fill="hsl(var(--muted-foreground))"
        >
          {sub}
        </text>
      )}
    </g>
  );
}

function Arrow({
  x1, y1, x2, y2, label, dashed = false, dotted = false, color = "hsl(var(--foreground))",
}: {
  x1: number; y1: number; x2: number; y2: number;
  label?: string; dashed?: boolean; dotted?: boolean; color?: string;
}) {
  const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  // arrowhead
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const ah1x = x2 - 8 * Math.cos(angle - 0.4);
  const ah1y = y2 - 8 * Math.sin(angle - 0.4);
  const ah2x = x2 - 8 * Math.cos(angle + 0.4);
  const ah2y = y2 - 8 * Math.sin(angle + 0.4);
  return (
    <g>
      <line
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={color}
        strokeOpacity={dotted ? 0.4 : 0.75}
        strokeWidth={1.2}
        strokeDasharray={dashed ? "5 5" : dotted ? "1 4" : undefined}
        className={dashed ? "flow-dash" : undefined}
      />
      <polygon
        points={`${x2},${y2} ${ah1x},${ah1y} ${ah2x},${ah2y}`}
        fill={color}
        fillOpacity={0.75}
      />
      {label && (
        <text
          x={mid.x}
          y={mid.y - 6}
          textAnchor="middle"
          fontSize="9"
          className="font-mono"
          fill="hsl(var(--muted-foreground))"
        >
          {label}
        </text>
      )}
    </g>
  );
}

function Pulse({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={14} fill={color} fillOpacity={0.15} className="pulse-dot" />
      <circle cx={x} cy={y} r={5.5} fill={color} />
    </g>
  );
}

/* ── individual step diagrams ───────────────────────────────────────────── */

function DiagTemplate() {
  return (
    <Frame caption="Operator → Pool · register_template">
      <Box x={50} y={150} w={120} h={70} label="Bitcoin RPC" sub="getblocktemplate" color="#f7931a" />
      <Box x={230} y={150} w={120} h={70} label="Pool" sub="register_template" color="#4DA2FF" />
      <Arrow x1={170} y1={185} x2={230} y2={185} label="signed" dashed />
      {/* The frozen template card */}
      <g transform="translate(170 270)">
        <rect width={60} height={50} rx={6} fill="hsl(var(--background))" stroke="hsl(var(--foreground))" strokeOpacity={0.4} />
        <text x={30} y={20} textAnchor="middle" fontSize="9" className="font-mono" fill="hsl(var(--muted-foreground))">FROZEN</text>
        <text x={30} y={36} textAnchor="middle" fontSize="11" fontWeight={600} fill="hsl(var(--foreground))">Template</text>
      </g>
      <Arrow x1={290} y1={220} x2={220} y2={270} dotted />
    </Frame>
  );
}

function DiagSubmit() {
  return (
    <Frame caption="ASIC → Sidecar → Sui · submit_share">
      <Box x={30}  y={170} w={90} h={60} label="ASIC" sub="cgminer · Avalon" color="#f7931a" />
      <Box x={155} y={170} w={90} h={60} label="Sidecar" sub="stratum v1" />
      <Box x={280} y={170} w={90} h={60} label="Sui PTB" sub="signed by miner" color="#4DA2FF" />
      <Arrow x1={120} y1={200} x2={155} y2={200} label="share" />
      <Arrow x1={245} y1={200} x2={280} y2={200} label="submit_share" dashed />
      {/* MinerStats owned objects */}
      <g transform="translate(30 280)">
        <rect width={340} height={70} rx={8} fill="hsl(var(--background))" stroke="hsl(var(--foreground))" strokeOpacity={0.25} strokeDasharray="3 3" />
        <text x={170} y={22} textAnchor="middle" fontSize="9" className="font-mono" fill="hsl(var(--muted-foreground))">OWNED OBJECTS · embarrassingly parallel</text>
        <text x={70}  y={50} textAnchor="middle" fontSize="11" fill="hsl(var(--foreground))">MinerStats</text>
        <text x={170} y={50} textAnchor="middle" fontSize="11" fill="hsl(var(--foreground))">MinerRoundStats</text>
        <text x={270} y={50} textAnchor="middle" fontSize="11" fill="hsl(var(--foreground))">ShareDedup</text>
      </g>
    </Frame>
  );
}

function DiagValidate() {
  return (
    <Frame caption="80-byte header reconstruction · SHA-256 ²">
      <Box x={50} y={70} w={120} h={50} label="Template" sub="version · prevhash" color="#4DA2FF" dim />
      <Box x={230} y={70} w={120} h={50} label="Miner input" sub="en2 · nonce · ntime" color="#a78bfa" />
      <Box x={130} y={170} w={140} h={70} label="80-byte header" sub="reconstructed" />
      <Arrow x1={110} y1={120} x2={170} y2={170} dotted />
      <Arrow x1={290} y1={120} x2={230} y2={170} dotted />
      <Box x={50}  y={290} w={130} h={60} label="SHA256²" />
      <Box x={220} y={290} w={130} h={60} label="≤ target?" sub="share / block / drop" color="#22c55e" />
      <Arrow x1={200} y1={240} x2={115} y2={290} />
      <Arrow x1={180} y1={320} x2={220} y2={320} dashed />
    </Frame>
  );
}

function DiagBlockFound() {
  return (
    <Frame caption="Share clears full target → claim frozen">
      <Box x={40} y={70} w={140} h={60} label="submit_share" sub="is_block == true" color="#f7931a" />
      <Arrow x1={180} y1={100} x2={250} y2={100} dashed />
      <Box x={250} y={70} w={120} h={60} label="BlockFoundClaim" sub="frozen object" />
      <g transform="translate(110 200)">
        <rect width={180} height={120} rx={10} fill="hsl(var(--background))" stroke="hsl(var(--foreground))" strokeOpacity={0.4} />
        <text x={90} y={26} textAnchor="middle" fontSize="9" className="font-mono" fill="hsl(var(--muted-foreground))">CLAIM</text>
        <text x={20} y={58} fontSize="11" fill="hsl(var(--muted-foreground))">round_id</text>
        <text x={160} y={58} textAnchor="end" fontSize="11" fontWeight={600} fill="hsl(var(--foreground))">42</text>
        <text x={20} y={82} fontSize="11" fill="hsl(var(--muted-foreground))">height</text>
        <text x={160} y={82} textAnchor="end" fontSize="11" fontWeight={600} fill="hsl(var(--foreground))">874_321</text>
        <text x={20} y={106} fontSize="11" fill="hsl(var(--muted-foreground))">block_finder</text>
        <text x={160} y={106} textAnchor="end" fontSize="10" className="font-mono" fontWeight={600} fill="hsl(var(--foreground))">0x7be6…</text>
      </g>
      <text x={200} y={358} textAnchor="middle" fontSize="10" className="font-mono" fill="hsl(var(--muted-foreground))">
        the only key downstream actions accept
      </text>
    </Frame>
  );
}

function DiagAccumulator() {
  return (
    <Frame caption="Permissionless open · claim is the key">
      <Box x={50} y={70} w={130} h={60} label="BlockFoundClaim" sub="frozen" />
      <Box x={220} y={70} w={130} h={60} label="open_round_…" sub="_from_claim" color="#4DA2FF" />
      <Arrow x1={180} y1={100} x2={220} y2={100} dashed label="@claim_id" />
      <Box x={120} y={210} w={160} h={80} label="RoundAccumulator" sub="shared object" color="#a78bfa" />
      <Arrow x1={285} y1={130} x2={220} y2={210} />
      <g transform="translate(60 320)">
        <text fontSize="10" className="font-mono" fill="hsl(var(--muted-foreground))">accumulate_miner_stats(mrs[])</text>
        <text y={16} fontSize="10" className="font-mono" fill="hsl(var(--muted-foreground))">→ MinerWorkRecord transferred</text>
      </g>
    </Frame>
  );
}

function DiagFinalize() {
  return (
    <Frame caption="After ACCUMULATION_WINDOW_MS · finalize_round">
      <Box x={120} y={60} w={160} h={70} label="RoundAccumulator" sub="shared · open" color="#a78bfa" />
      <Arrow x1={200} y1={130} x2={200} y2={210} label="finalize" dashed />
      <Box x={100} y={210} w={200} h={120} label="RoundHistory" sub="frozen · final total_net_work" color="#22c55e" />
      <text x={200} y={355} textAnchor="middle" fontSize="9" className="font-mono" fill="hsl(var(--muted-foreground))">
        share weights are now immutable on-chain
      </text>
    </Frame>
  );
}

function DiagHashiDeposit() {
  return (
    <Frame caption="BTC signet → Hashi P2TR derived from vault UID">
      <Box x={30} y={80} w={130} h={60} label="Operator wallet" sub="signet" color="#f7931a" />
      <Box x={230} y={80} w={130} h={60} label="HashiVault<BTC>" sub="P2TR · derived" />
      <Arrow x1={160} y1={110} x2={230} y2={110} label="UTXO" dashed />
      <Box x={30}  y={230} w={150} h={70} label="record_block_found" sub="claim · txid · vout" color="#4DA2FF" />
      <Box x={220} y={230} w={150} h={70} label="BlockDepositRecord" sub="UNREGISTERED" />
      <Arrow x1={180} y1={265} x2={220} y2={265} />
      <Arrow x1={295} y1={140} x2={295} y2={230} dotted />
    </Frame>
  );
}

function DiagHashiConfirm() {
  return (
    <Frame caption="Hashi committee · Bitcoin confirmations">
      <Box x={50} y={70} w={140} h={70} label="MPC committee" sub="off-chain" />
      <Box x={210} y={70} w={140} h={70} label="BlockDepositRecord" sub="CONFIRMED" color="#22c55e" />
      <Arrow x1={190} y1={105} x2={210} y2={105} dashed />
      <Box x={50}  y={210} w={140} h={70} label="HashiVault" sub="HBTC minted" color="#4DA2FF" />
      <Box x={210} y={210} w={140} h={70} label="vault.hbtc" sub="balance += amount" />
      <Arrow x1={190} y1={245} x2={210} y2={245} />
      <Arrow x1={280} y1={140} x2={120} y2={210} dotted />
    </Frame>
  );
}

function DiagFundBatch() {
  return (
    <Frame caption="open_and_fund_round_batch · permissionless">
      <Box x={20}  y={70} w={120} h={60} label="HashiVault" sub="hbtc balance" />
      <Box x={150} y={70} w={120} h={60} label="DepositRecord" sub="CONFIRMED" color="#22c55e" />
      <Box x={280} y={70} w={100} h={60} label="RoundHistory" sub="frozen" color="#a78bfa" />
      <Box x={100} y={230} w={200} h={90} label="HashiRewardBatch" sub="FUNDED · exact amount_sats" color="#4DA2FF" />
      <Arrow x1={80}  y1={130} x2={150} y2={230} dashed />
      <Arrow x1={210} y1={130} x2={210} y2={230} dashed />
      <Arrow x1={330} y1={130} x2={270} y2={230} dotted />
    </Frame>
  );
}

function DiagMint() {
  return (
    <Frame caption="Same PTB as submit_share · mint_share_to<T>">
      <Box x={30} y={70} w={130} h={60} label="ShareReceipt" sub="consumed" color="#a78bfa" />
      <Box x={210} y={70} w={150} h={60} label="HashShareRegistry" sub="bind_slot_to_round" color="#4DA2FF" />
      <Arrow x1={160} y1={100} x2={210} y2={100} dashed />
      <Box x={120} y={210} w={160} h={70} label="Coin<HS_NNN>" sub="− 1% protocol fee" color="#a78bfa" />
      <Arrow x1={200} y1={130} x2={200} y2={210} dashed label="mint" />
      <Box x={50}  y={310} w={140} h={50} label="Miner wallet" sub="instantly liquid" color="#22c55e" />
      <Box x={210} y={310} w={140} h={50} label="fee_recipient" sub="protocol" dim />
      <Arrow x1={150} y1={280} x2={120} y2={310} />
      <Arrow x1={260} y1={280} x2={280} y2={310} dotted />
    </Frame>
  );
}

function DiagDeepBook() {
  return (
    <Frame caption="SlotBoundToRound → create_permissionless_pool">
      <Box x={20}  y={70} w={120} h={50} label="Registry" sub="SlotBoundToRound" color="#4DA2FF" />
      <Box x={150} y={70} w={120} h={50} label="Keeper" sub="observes event" />
      <Box x={280} y={70} w={100} h={50} label="DeepBookV3" sub="pool created" color="#1E6EF3" />
      <Arrow x1={140} y1={95} x2={150} y2={95} dashed />
      <Arrow x1={270} y1={95} x2={280} y2={95} dashed />
      <g transform="translate(60 180)">
        <rect width={280} height={150} rx={10} fill="hsl(var(--background))" stroke="hsl(var(--foreground))" strokeOpacity={0.3} />
        <text x={140} y={20} textAnchor="middle" fontSize="9" className="font-mono" fill="hsl(var(--muted-foreground))">Pool&lt;HS_NNN, QUOTE&gt;</text>
        {/* bids/asks bars */}
        {[18, 30, 42, 54, 66, 78, 90].map((bx, i) => (
          <rect key={`a${i}`} x={20 + bx * 2.4} y={42 + (i % 3) * 4} width={5} height={28 - i * 2} fill="#ef4444" fillOpacity={0.7} />
        ))}
        {[18, 30, 42, 54, 66, 78, 90].map((bx, i) => (
          <rect key={`b${i}`} x={20 + bx * 2.4} y={90} width={5} height={18 + i * 3} fill="#22c55e" fillOpacity={0.7} />
        ))}
        <line x1={20} y1={86} x2={260} y2={86} stroke="hsl(var(--foreground))" strokeOpacity={0.25} />
      </g>
    </Frame>
  );
}

function DiagClaim() {
  return (
    <Frame caption="claim_reward · MWR → Coin<BTC>">
      <Box x={30} y={70} w={130} h={60} label="MinerWorkRecord" sub="consumed" color="#a78bfa" />
      <Box x={210} y={70} w={150} h={60} label="HashiRewardBatch" sub="balance share" color="#4DA2FF" />
      <Arrow x1={160} y1={100} x2={210} y2={100} dashed label="my_mwr.net_work" />
      <Box x={120} y={210} w={160} h={70} label="Coin<HBTC>" sub="net_work × ratio" color="#22c55e" />
      <Arrow x1={200} y1={130} x2={200} y2={210} dashed />
      <g transform="translate(40 320)">
        <Pulse x={20} y={20} color="#22c55e" />
        <text x={50} y={26} fontSize="11" fill="hsl(var(--foreground))">parallel claims · no Table writes</text>
      </g>
    </Frame>
  );
}
